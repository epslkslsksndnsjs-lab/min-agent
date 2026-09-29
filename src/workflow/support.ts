/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Host shims for the ported engine — the two utilities upstream pulled from its
// own utils/ tree, reimplemented against min-agent. See PROVENANCE.md.
//
// Debug output goes to a file, never to stderr: min-agent drives the terminal
// through an alternate-screen buffer with line-diffed repaints (src/tui/tui.ts),
// so a stray write would corrupt the frame it is diffing against.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Remove ANSI/VT sequences and remaining control characters, so a tool's output
 * can be echoed into a message that is shown to a human or hashed into a resume
 * key without smuggling escape codes or line breaks through.
 */
export function stripAnsiAndControl(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_CHARS_RE, '');
}

export interface DebugLogger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** The env var that turns workflow debug logging on, and where it writes. */
const DEBUG_ENV = 'MIN_AGENT_DEBUG_WORKFLOW';
const LOG_PATH_ENV = 'MIN_AGENT_DEBUG_LOG';

let cachedPath: string | null | undefined;

function logPath(): string | null {
  if (!process.env[DEBUG_ENV]) return null;
  if (cachedPath === undefined) {
    const target = process.env[LOG_PATH_ENV] ?? join(tmpdir(), 'min-agent-workflow-debug.log');
    try {
      mkdirSync(dirname(target), { recursive: true });
      cachedPath = target;
    } catch {
      cachedPath = null;
    }
  }
  return cachedPath;
}

function write(level: string, tag: string, message: string, args: unknown[]): void {
  const target = logPath();
  if (!target) return;
  const tail = args.length > 0 ? ' ' + args.map((a) => stringify(a)).join(' ') : '';
  try {
    appendFileSync(target, `${new Date().toISOString()} ${level} [${tag}] ${message}${tail}\n`, 'utf-8');
  } catch {
    // Debug logging must never be the reason a run fails.
  }
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A tag-scoped logger. Silent unless MIN_AGENT_DEBUG_WORKFLOW is set; then
 * append-only to a file, because the TUI owns the screen.
 */
export function createDebugLogger(tag: string): DebugLogger {
  return {
    debug: (message, ...args) => write('DEBUG', tag, message, args),
    warn: (message, ...args) => write('WARN', tag, message, args),
    error: (message, ...args) => write('ERROR', tag, message, args),
  };
}
