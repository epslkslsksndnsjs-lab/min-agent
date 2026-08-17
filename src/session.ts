// src/session.ts
// Session persistence: append context.messages to ~/.min-agent/session.jsonl.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Message } from './llm.js'

const SESSION_DIR = path.join(os.homedir(), '.min-agent')
const SESSION_FILE = path.join(SESSION_DIR, 'session.jsonl')

// Track how many messages are already persisted; only append the new ones.
// This is process-level state (not agent state — the agent is stateless;
// context IS the state).
let persistedCount = 0

/** Load historical messages on startup to resume the last conversation (exported for tests) */
export async function loadSession(file: string = SESSION_FILE): Promise<Message[]> {
  try {
    const data = await fs.readFile(file, 'utf-8')
    const lines = data.trim().split('\n').filter(Boolean)
    // Per-line fault tolerance: skip corrupted lines instead of discarding all history (a crash may write a half line of JSON)
    const messages = lines.flatMap(line => {
      try { return [JSON.parse(line) as Message] } catch { return [] }
    })
    persistedCount = messages.length  // Don't re-write what's already loaded
    return messages
  } catch {
    return []  // File missing — start empty
  }
}

/** Persist messages to the session file (exported for tests) */
export async function persistSession(messages: Message[], file: string = SESSION_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file) || '.', { recursive: true })
  const newMessages = messages.slice(persistedCount)
  for (const msg of newMessages) {
    await fs.appendFile(file, JSON.stringify(msg) + '\n', 'utf-8')
  }
  persistedCount = messages.length
}
