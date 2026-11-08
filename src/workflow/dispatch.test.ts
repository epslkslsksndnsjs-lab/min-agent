// The seam, tested: what one `agent()` call actually does inside min-agent.
//
// The model is faked the same way `src/agent.test.ts` fakes it — `stream`
// replaced with a scripted generator — because these tests are about the
// dispatch, not about a provider. Everything else is real: real schema
// compilation, the real structured_output tool, real paths (redirected to a
// temp MIN_AGENT_HOME so a test never writes into the user's ~/.min-agent).
//
// One scripted sequence per model call: `runAgent` always requests a further
// turn after executing a tool, so a turn that ends the run must be followed by
// a sequence that stops calling tools.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentTool } from '../agent.js';
import { stream, type Context, type Message, type Model, type StreamEvent } from '../llm.js';
import { createMinAgentDispatch } from './dispatch.js';
import { createWorkflowPaths } from './paths.js';
import { WorkflowAgentFailedError } from './agent-failure.js';
import {
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
} from './orchestrator.js';
import { WorkflowEventEmitter } from './events.js';

vi.mock('../llm.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../llm.js');
  return { ...actual, stream: vi.fn() };
});

const model: Model = { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1' };

/**
 * One recorded model call. The messages are CLONED at call time: `runAgent`
 * mutates the context it was handed, so reading it later would show the
 * conversation as it ended rather than as the request went out.
 */
interface RecordedCall {
  messages: Message[];
  tools: string[];
}
let calls: RecordedCall[] = [];

function mockStream(...sequences: StreamEvent[][]): void {
  const mocked = vi.mocked(stream);
  mocked.mockReset();
  calls = [];
  for (const sequence of sequences) {
    mocked.mockImplementationOnce(async function* (
      _model: Model,
      context: Context,
      opts?: { tools?: { name: string }[] },
    ) {
      calls.push({
        messages: JSON.parse(JSON.stringify(context.messages)) as Message[],
        tools: (opts?.tools ?? []).map((tool) => tool.name),
      });
      for (const event of sequence) yield event;
    });
  }
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'min-agent-wf-test-'));
  process.env['MIN_AGENT_HOME'] = home;
});
afterEach(() => {
  vi.resetAllMocks();
  delete process.env['MIN_AGENT_HOME'];
  rmSync(home, { recursive: true, force: true });
});

const sessionTools: AgentTool[] = [
  {
    name: 'read_file',
    description: 'read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async () => 'file contents',
  },
  {
    name: 'write_file',
    description: 'write a file',
    input_schema: { type: 'object' },
    execute: async () => 'ok',
  },
  // The session may well have a workflow tool; a subagent must never get it.
  {
    name: 'workflow',
    description: 'fan out further',
    input_schema: { type: 'object' },
    execute: async () => 'should never run',
  },
];

type DispatchOptions = Parameters<typeof createMinAgentDispatch>[0];

function makeDispatch(overrides: Partial<DispatchOptions> = {}) {
  return createMinAgentDispatch({
    runId: 'wf_test0001',
    model,
    tools: sessionTools,
    cwd: process.cwd(),
    paths: createWorkflowPaths(process.cwd()),
    bounds: {
      max_turns: DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
      max_time_minutes: DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
    },
    env: { MIN_AGENT_WORKFLOW_STALL_SECONDS: '0' },
    ...overrides,
  });
}

describe('createMinAgentDispatch', () => {
  it('runs the subagent in its own context and returns its final text', async () => {
    mockStream([
      { type: 'text_delta', delta: 'the answer' },
      { type: 'done', stopReason: 'end_turn' },
    ]);

    const result = await makeDispatch()('count the files', { stallMs: 0 });

    expect(result).toBe('the answer');
    // A fresh context: only the script's prompt, never the parent conversation.
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'count the files' }]);
  });

  it('never offers the workflow tool to a subagent, so it cannot fan out', async () => {
    mockStream([{ type: 'done', stopReason: 'end_turn' }]);

    await makeDispatch()('x', { stallMs: 0 });

    expect(calls[0]!.tools).toContain('read_file');
    expect(calls[0]!.tools).not.toContain('workflow');
  });

  it('reports each dispatch output tokens once, for the budget ledger', async () => {
    mockStream([
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 42, totalTokens: 52 } },
      { type: 'text_delta', delta: 'here' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const seen: number[] = [];

    await makeDispatch({ onTokens: (n) => seen.push(n) })('x', { stallMs: 0 });

    expect(seen).toEqual([42]);
  });

  it('narrows tools per call, and throws when the denies leave nothing to call', async () => {
    mockStream([{ type: 'done', stopReason: 'end_turn' }]);
    await makeDispatch()('x', { stallMs: 0, tools: ['read_file'] });
    expect(calls[0]!.tools).toEqual(['read_file']);

    // write_file is denied outright, so the allowlist bounds it away and the
    // agent would have had nothing — refused rather than paid for.
    await expect(
      makeDispatch()('x', {
        stallMs: 0,
        tools: ['write_file'],
        disallowedTools: ['write_file'],
      }),
    ).rejects.toThrow(/none of/);
  });

  it('returns the validated object when the agent answers through structured_output', async () => {
    mockStream([
      { type: 'tool_call', id: 't1', name: 'structured_output', args: { files: 3, ok: true } },
      { type: 'done', stopReason: 'tool_use' },
    ]);

    const result = await makeDispatch()('x', {
      stallMs: 0,
      schema: {
        type: 'object',
        properties: { files: { type: 'integer' }, ok: { type: 'boolean' } },
        required: ['files', 'ok'],
        additionalProperties: false,
      },
    });

    expect(result).toEqual({ files: 3, ok: true });
    // The run ends on the valid submission; no further model call is bought.
    expect(calls).toHaveLength(1);
  });

  it('fails as no_structured_output after three rejected submissions', async () => {
    mockStream(
      [
        { type: 'tool_call', id: 't1', name: 'structured_output', args: { files: 'one' } },
        { type: 'tool_call', id: 't2', name: 'structured_output', args: { files: 'two' } },
        { type: 'tool_call', id: 't3', name: 'structured_output', args: { files: 'three' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    );

    const error = await makeDispatch()('x', {
      stallMs: 0,
      schema: {
        type: 'object',
        properties: { files: { type: 'integer' } },
        required: ['files'],
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowAgentFailedError);
    expect((error as WorkflowAgentFailedError).kind).toBe('no_structured_output');
    expect((error as Error).message).toMatch(/3 submissions were rejected/);
  });

  it('refuses a schema that will not compile, before the agent starts', async () => {
    const error = await makeDispatch()('x', {
      stallMs: 0,
      schema: { type: 'object', properties: { a: { type: 'not-a-json-type' } } },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowAgentFailedError);
    expect((error as Error).message).toMatch(/agent\(\{schema\}\)/);
    expect(vi.mocked(stream)).not.toHaveBeenCalled();
  });

  it('hits the per-attempt turn ceiling and reports max_turns', async () => {
    const turn = (id: string): StreamEvent[] => [
      { type: 'tool_call', id, name: 'read_file', args: { path: 'a' } },
      { type: 'done', stopReason: 'tool_use' },
    ];
    mockStream(turn('a'), turn('b'), turn('c'));

    const error = await makeDispatch({
      bounds: { max_turns: 2, max_time_minutes: 10 },
    })('x', { stallMs: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowAgentFailedError);
    expect((error as WorkflowAgentFailedError).kind).toBe('max_turns');
  });

  it('lets the human deny a tool call, and tells the model it was denied', async () => {
    mockStream(
      [
        { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'secret' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'understood' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    );

    // The approval channel is the bus: a surface answers by calling `respond`.
    const emitter = new WorkflowEventEmitter();
    emitter.on('tool_waiting_approval', (event) => event.respond('deny'));

    const result = await makeDispatch({ emitter })('x', { stallMs: 0 });

    expect(result).toBe('understood');
    // The denial reaches the model as the tool result, not as an exception, so
    // the agent can still finish and say what it wanted.
    expect(JSON.stringify(calls[1]!.messages)).toContain('the user denied this read_file call');
  });

  it('runs the tool unasked when no approval surface is listening', async () => {
    mockStream(
      [
        { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'read it' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    );
    // An emitter with no approval listener — the shape of a print-mode session.
    const emitter = new WorkflowEventEmitter();

    const result = await makeDispatch({ emitter })('x', { stallMs: 0 });

    // "Nobody to ask" is no gate: not a hang, and not a denial the user never
    // configured. The tool ran and its output came back.
    expect(result).toBe('read it');
    expect(JSON.stringify(calls[1]!.messages)).toContain('file contents');
  });

  it('publishes the subagent tool calls onto the run bus', async () => {
    const emitter = new WorkflowEventEmitter();
    const seen: string[] = [];
    emitter.on('tool_call', (payload) => seen.push(payload.name));
    emitter.on('finish', () => seen.push('finish'));
    mockStream(
      [
        { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    );

    await makeDispatch({ emitter })('x', { stallMs: 0 });

    expect(seen).toEqual(['read_file', 'finish']);
  });
});
