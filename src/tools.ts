// src/tools.ts
// Built-in tools: read, write, edit code, and run verification.
// Each tool is a pure function: async (args) => string, never touching agent state.
// Args are not validated here — validation stays with the caller so tools stay decoupled.

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'

const execAsync = promisify(exec)

/** Tool output truncation cap (in lines); beyond it, keep the tail and warn */
const MAX_OUTPUT_LINES = 200

let truncateCounter = 0

/**
 * Truncate tool output: when over maxLines, keep only the tail and spill the full output to a temp file.
 * Tail-first — error info is usually at the end.
 */
async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `min-agent-output-${process.pid}-${truncateCounter++}.txt`)
  await fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

/** read_file: return file content (tail-truncated to avoid huge output) */
const readFile: AgentTool = {
  name: 'read_file',
  description: 'Read a file. Args: path (file path). Large files are tail-truncated to the last 200 lines.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string }
    const content = await fs.readFile(filePath, 'utf-8')
    return await truncateOutput(content)
  },
}

/** write_file: overwrite a file */
const writeFile: AgentTool = {
  name: 'write_file',
  description: 'Write (overwrite) a file. Args: path (file path), content (file content)',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as { path: string; content: string }
    await fs.mkdir(path.dirname(filePath) || '.', { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `wrote ${filePath} (${content.length} chars)`
  },
}

/** edit: local string replacement (exact match + uniqueness check) */
const edit: AgentTool = {
  name: 'edit',
  description: 'Edit a file by exact string replacement. Args: path, old_string, new_string. old_string must match exactly once in the file, otherwise it errors.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Text to replace (must match exactly once)' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    const { path: filePath, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
    const content = await fs.readFile(filePath, 'utf-8')
    const count = content.split(old_string).length - 1
    if (count === 0) throw new Error(`old_string not found in ${filePath}`)
    if (count > 1) throw new Error(`old_string matches ${count} places in ${filePath}, must be unique`)
    // Use a function replacement so special $ chars in new_string ($& $` $' $1) aren't interpreted by String.replace
    const newContent = content.replace(old_string, () => new_string)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `edited ${filePath}: replaced ${old_string.length} chars`
  },
}

/** run_bash: run a shell command (tail-truncated output to avoid huge output) */
const runBash: AgentTool = {
  name: 'run_bash',
  description: 'Run a shell command. Args: command (command string). Returns stdout+stderr, tail-truncated to the last 200 lines.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string }
    try {
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024, timeout: 30000, signal })
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout
      return await truncateOutput(output)
    } catch (e: unknown) {
      if (signal?.aborted) return 'aborted'
      const err = e as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      return `[exit ${err.code}] ${err.stderr ?? ''}${err.stdout ?? ''}`
    }
  },
}

/** Return all built-in tools */
export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash]
}
