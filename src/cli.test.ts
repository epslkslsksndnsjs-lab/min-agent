// Tests for session persistence in src/cli.ts (loadSession / persistSession).
// `persistSession` uses a module-level `persistedCount` to append only new messages,
// so each test gets a fresh module via vi.resetModules() to avoid cross-test state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { Message } from './llm.js'

let cli: typeof import('./cli.js')
let file: string

beforeEach(async () => {
  vi.resetModules()
  cli = await import('./cli.js')
  file = path.join(os.tmpdir(), `min-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
})

describe('session persistence', () => {
  it('round-trips string messages through save and load', async () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ]
    await cli.persistSession(msgs, file)
    expect(await cli.loadSession(file)).toEqual(msgs)
  })

  it('round-trips structured content blocks (tool_result) without loss', async () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'result data' }],
    }]
    await cli.persistSession(msgs, file)
    expect(await cli.loadSession(file)).toEqual(msgs)
  })

  it('skips corrupt lines on load and keeps the valid ones', async () => {
    const valid: Message[] = [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'fine' },
    ]
    const lines = [
      JSON.stringify(valid[0]),
      '{ this is not valid json',
      JSON.stringify(valid[1]),
    ]
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8')

    expect(await cli.loadSession(file)).toEqual(valid)
  })

  it('returns an empty array when the session file is missing', async () => {
    expect(await cli.loadSession(path.join(os.tmpdir(), `min-agent-missing-${Date.now()}.jsonl`))).toEqual([])
  })

  it('appends only new messages on a second persist (incremental)', async () => {
    const first: Message[] = [{ role: 'user', content: 'a' }]
    const second: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]

    await cli.persistSession(first, file)   // persistedCount -> 1
    await cli.persistSession(second, file)  // appends only the new message

    const lines = (await fs.readFile(file, 'utf-8')).trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(await cli.loadSession(file)).toEqual(second)
  })
})
