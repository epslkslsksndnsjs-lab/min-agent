// src/tools.ts
// Built-in tools: read, write, edit, run commands, and search the codebase.
// Each tool is a pure function: async (args) => string, never touching agent state.
// Args are not validated here — validation stays with the caller so tools stay decoupled.
//
// Tool names are kept stable (run_bash / read_file / write_file / edit) and two
// search tools (grep / glob) are added. The grep/glob backends live in search.ts
// and are ripgrep-backed with a pure-Node fallback.

import { promises as fs, createReadStream, readdirSync } from 'node:fs'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'
import { globSearch, grepSearch, type GrepParams } from './search.js'

const execAsync = promisify(exec)

const MAX_FOREGROUND_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_LINES = 200
const GLOB_LIMIT = 100

// Read-tool caps, copied from the reference Read tool (limits.ts / readFileInRange.ts).
const MAX_FILE_READ_BYTES = 0.25 * 1024 * 1024 // 256 KB — total file size cap when no limit is given
const MAX_FILE_READ_TOKENS = 25_000 // rough token cap on the returned slice
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB — guard against OOM on huge edits
const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB — read whole file in memory below this, else stream

// Device files the reference Read tool refuses: infinite output or blocking input.
// Checked by path only (no I/O); safe devices like /dev/null are intentionally allowed.
const BLOCKED_DEVICE_PATHS = new Set<string>([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

let truncateCounter = 0

// Truncate tool output: when over maxLines, keep only the tail and spill the full output to a temp file.
function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `min-agent-output-${process.pid}-${truncateCounter++}.txt`)
  void fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

// Merge stderr into stdout, mirroring the reference tool's merged-fd behavior
// so the model sees stderr inline with stdout.
function mergeOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout
  if (!stdout) return stderr
  return stdout.endsWith('\n') ? stdout + stderr : `${stdout}\n${stderr}`
}

// Trim leading blank lines and trailing whitespace, copied from the reference
// tool's model-facing output cleanup.
function cleanOutput(out: string): string {
  return out.replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined
}

function asBoolean(v: unknown): boolean {
  return v === true || v === 'true'
}

// Convert an absolute path to one relative to the current working directory,
// mirroring the reference tool's toRelativePath (saves tokens in results).
function toRelative(p: string): string {
  return path.relative(process.cwd(), p)
}

// Build the "limit: N, offset: M" pagination fragment, copied from the
// reference tool's formatLimitInfo (only non-empty parts are joined).
function formatLimitInfo(appliedLimit: number | undefined, appliedOffset: number | undefined): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

// Expand a leading ~ to the user's home dir (mirrors the reference expandPath,
// which keeps hook allowlists from being bypassed via relative paths).
function expandPath(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') || filePath.endsWith('/fd/1') || filePath.endsWith('/fd/2'))
  ) {
    return true
  }
  return false
}

// Human-readable byte size, copied from the reference formatFileSize.
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

// Format file content with 1-based line-number prefixes, copied from the
// reference addLineNumbers (default, non-compact format).
function addLineNumbers(content: string, startLine: number): string {
  if (!content) return ''
  const lines = content.split('\n')
  return lines
    .map((line, index) => {
      const num = String(index + startLine)
      return num.length >= 6 ? `${num}→${line}` : `${num.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

// Find a file with the same base name but a different extension in the same dir.
function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath, path.extname(filePath))
    const entries = readdirSync(dir)
    const hit = entries.find(
      (e) => path.basename(e, path.extname(e)) === base && path.join(dir, e) !== filePath,
    )
    return hit
  } catch {
    return undefined
  }
}

// Detect the "dropped repo folder" pattern: the requested path is under cwd's
// parent but not under cwd itself, and the same relative path exists under cwd.
async function suggestPathUnderCwd(requestedPath: string): Promise<string | undefined> {
  const cwd = process.cwd()
  const cwdParent = path.dirname(cwd)
  const prefix = cwdParent === path.sep ? path.sep : `${cwdParent}${path.sep}`
  if (
    !requestedPath.startsWith(prefix) ||
    requestedPath.startsWith(`${cwd}${path.sep}`) ||
    requestedPath === cwd
  ) {
    return undefined
  }
  const corrected = path.join(cwd, path.relative(cwdParent, requestedPath))
  try {
    await fs.stat(corrected)
    return corrected
  } catch {
    return undefined
  }
}

// Select lines [lineOffset, lineOffset + maxLines) from text, stripping a
// leading BOM and trailing \r (CRLF -> LF). Mirrors the reference fast path.
function sliceLines(
  text: string,
  lineOffset: number,
  maxLines?: number,
): { content: string; totalLines: number } {
  const endLine = maxLines !== undefined ? lineOffset + maxLines : Infinity
  const selected: string[] = []
  let lineIndex = 0
  let start = 0
  let nl: number
  while ((nl = text.indexOf('\n', start)) !== -1) {
    if (lineIndex >= lineOffset && lineIndex < endLine) {
      let line = text.slice(start, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      selected.push(line)
    }
    lineIndex++
    start = nl + 1
  }
  if (start < text.length && lineIndex >= lineOffset && lineIndex < endLine) {
    let line = text.slice(start)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    selected.push(line)
    lineIndex++
  }
  return { content: selected.join('\n'), totalLines: lineIndex }
}

// Streaming line reader for files larger than FAST_PATH_MAX_SIZE when a limit
// is given. Only selected lines are accumulated, so a huge file with a small
// slice won't balloon memory. Mirrors the reference streaming path.
function readFileRangeStreaming(
  filePath: string,
  lineOffset: number,
  maxLines: number | undefined,
  signal?: AbortSignal,
): Promise<{ content: string; totalLines: number }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 512 * 1024,
      ...(signal ? { signal } : undefined),
    })
    const endLine = maxLines !== undefined ? lineOffset + maxLines : Infinity
    const selected: string[] = []
    let lineIndex = 0
    let partial = ''
    let isFirst = true
    stream.on('data', (chunkRaw: string | Buffer) => {
      let chunk = typeof chunkRaw === 'string' ? chunkRaw : chunkRaw.toString('utf8')
      if (isFirst) {
        isFirst = false
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
      }
      const data = partial + chunk
      partial = ''
      let start = 0
      let nl: number
      while ((nl = data.indexOf('\n', start)) !== -1) {
        if (lineIndex >= lineOffset && lineIndex < endLine) {
          let line = data.slice(start, nl)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          selected.push(line)
        }
        lineIndex++
        start = nl + 1
      }
      if (start < data.length) partial = data.slice(start)
    })
    stream.on('end', () => {
      if (partial.length > 0 && lineIndex >= lineOffset && lineIndex < endLine) {
        let line = partial
        if (line.endsWith('\r')) line = line.slice(0, -1)
        selected.push(line)
      }
      lineIndex++
      resolve({ content: selected.join('\n'), totalLines: lineIndex })
    })
    stream.on('error', reject)
  })
}

// --- read_file ---------------------------------------------------------------

const readFile: AgentTool = {
  name: 'read_file',
  description:
    `Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:
- The path parameter must be an absolute path, not a relative path. A leading ~ is expanded to the home directory.
- By default the entire file is read and returned with 1-based line numbers. Use offset (start line, 1-based) and limit (number of lines) to read a specific slice.
- Files larger than 256 KB must be read with offset and limit; reading the whole file at once returns an error. Files larger than 10 MB are streamed line by line.
- Returned content is capped at a rough 25,000-token estimate (chars divided by 4); use offset and limit for larger portions, or search for specific content instead.
- Text files only. Binary files (those containing NUL bytes) are rejected with an error.
- Device files such as /dev/zero, /dev/random, /dev/stdin, /dev/tty and /proc/*/fd/0-2 are blocked because they would hang or produce infinite output.
- If the file does not exist, the tool reports the current working directory and may suggest a similarly named file or the same path under the working directory.
- This tool reads files, not directories. To inspect a directory, list it through the Bash tool.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path to the file to read (a leading ~ expands to the home directory).' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based). Only provide if the file is too large to read at once.' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Only provide if the file is too large to read at once.' },
    },
    required: ['path'],
  },
  execute: async (args, signal) => {
    const { path: filePath, offset, limit } = args as {
      path: string
      offset?: number
      limit?: number
    }
    const fullPath = expandPath(filePath)
    if (isBlockedDevicePath(fullPath)) {
      throw new Error(
        `Cannot read '${filePath}': this device file would block or produce infinite output.`,
      )
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(fullPath)
    } catch (e) {
      if (isENOENT(e)) {
        const similar = findSimilarFile(fullPath)
        const cwdSuggestion = await suggestPathUnderCwd(fullPath)
        let message = `File does not exist. Note: your current working directory is ${process.cwd()}.`
        if (cwdSuggestion) message += ` Did you mean ${cwdSuggestion}?`
        else if (similar) message += ` Did you mean ${similar}?`
        throw new Error(message)
      }
      throw e
    }

    if (stats.isDirectory()) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`)
    }

    const startLine = offset ?? 1
    const lineOffset = startLine === 0 ? 0 : startLine - 1

    // Size cap only applies when no explicit limit is given (matches the
    // reference Read tool, which gates on total file size, not the slice).
    if (limit === undefined && stats.size > MAX_FILE_READ_BYTES) {
      throw new Error(
        `File content (${formatFileSize(stats.size)}) exceeds maximum allowed size (${formatFileSize(
          MAX_FILE_READ_BYTES,
        )}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      )
    }

    let content: string
    let totalLines: number
    if (stats.size <= FAST_PATH_MAX_SIZE || limit !== undefined) {
      const raw = await fs.readFile(fullPath, 'utf-8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const result = sliceLines(text, lineOffset, limit)
      content = result.content
      totalLines = result.totalLines
    } else {
      const result = await readFileRangeStreaming(fullPath, lineOffset, limit, signal)
      content = result.content
      totalLines = result.totalLines
    }

    if (content.includes('\u0000')) {
      throw new Error(
        'This tool cannot read binary files. The file appears to be a binary file. Please use appropriate tools for binary file analysis.',
      )
    }

    // Rough token cap (chars / 4) mirrors the reference maxTokens gate without
    // requiring an API round-trip.
    if (Math.ceil(content.length / 4) > MAX_FILE_READ_TOKENS) {
      throw new Error(
        `File content (${Math.ceil(content.length / 4)} tokens) exceeds maximum allowed tokens (${MAX_FILE_READ_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      )
    }

    if (totalLines === 0) {
      return '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
    }
    if (startLine > totalLines) {
      return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`
    }

    return addLineNumbers(content, startLine)
  },
}

// --- write_file --------------------------------------------------------------

const writeFile: AgentTool = {
  name: 'write_file',
  description:
    `Writes a file to the local filesystem, overwriting any existing file at the given path. Parent directories are created automatically if they do not exist.

Usage:
- The path parameter must be an absolute path (a leading ~ is expanded to the home directory).
- Prefer the Edit tool for changing existing files - it only sends the changed portion. Use this tool to create new files or for complete rewrites of existing ones.
- Reading the existing file first is recommended before overwriting it, so you understand its current contents and avoid clobbering work.
- Returns a confirmation stating whether the file was created or updated.
- Do not create documentation files (*.md) or README files unless explicitly requested by the User.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path of the file to write (a leading ~ expands to the home directory).' },
      content: { type: 'string', description: 'The full content to write to the file.' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as { path: string; content: string }
    const fullPath = expandPath(filePath)
    const existed = await fs
      .stat(fullPath)
      .then(() => true)
      .catch(() => false)
    await fs.mkdir(path.dirname(fullPath) || '.', { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')
    return existed
      ? `The file ${fullPath} has been updated successfully.`
      : `File created successfully at: ${fullPath}`
  },
}

// --- edit --------------------------------------------------------------------

const edit: AgentTool = {
  name: 'edit',
  description:
    `Performs exact string replacements in a file.

Usage:
- The path parameter must be an absolute path (a leading ~ is expanded to the home directory).
- Read the file at least once before editing so old_string matches the current content exactly, including all whitespace and indentation.
- The edit fails if old_string is not found, or if it matches more than once while replace_all is false. Provide more surrounding context to make a match unique, or set replace_all to change every occurrence (useful for renaming a symbol throughout the file).
- An empty old_string creates a new file (when it does not exist) or writes into a file that is already empty.
- Files larger than 1 GiB cannot be edited.
- Prefer editing existing files in the codebase; avoid writing entirely new files unless explicitly required.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path of the file to edit (a leading ~ expands to the home directory).' },
      old_string: { type: 'string', description: 'The exact text to replace. Must match the file content exactly, including whitespace and indentation.' },
      new_string: { type: 'string', description: 'The text to insert in place of old_string.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string instead of requiring a unique match. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    const { path: filePath, old_string, new_string, replace_all } = args as {
      path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }
    if (old_string === new_string) {
      throw new Error('No changes to make: old_string and new_string are exactly the same.')
    }
    const fullPath = expandPath(filePath)

    let content: string
    try {
      const buf = await fs.readFile(fullPath)
      if (buf.length > MAX_EDIT_FILE_SIZE) {
        throw new Error(
          `File is too large to edit (${formatFileSize(buf.length)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
        )
      }
      content = buf.toString('utf8')
    } catch (e) {
      if (isENOENT(e)) {
        // Empty old_string on a nonexistent file means "create it".
        if (old_string === '') {
          await fs.mkdir(path.dirname(fullPath) || '.', { recursive: true })
          await fs.writeFile(fullPath, new_string, 'utf-8')
          return `The file ${fullPath} has been updated successfully.`
        }
        const similar = findSimilarFile(fullPath)
        const cwdSuggestion = await suggestPathUnderCwd(fullPath)
        let message = `File does not exist. Note: your current working directory is ${process.cwd()}.`
        if (cwdSuggestion) message += ` Did you mean ${cwdSuggestion}?`
        else if (similar) message += ` Did you mean ${similar}?`
        throw new Error(message)
      }
      throw e
    }

    // Empty old_string on an existing file: only valid to write into an empty file.
    if (old_string === '') {
      if (content.trim() !== '') {
        throw new Error('Cannot create new file - file already exists.')
      }
      await fs.writeFile(fullPath, new_string, 'utf-8')
      return `The file ${fullPath} has been updated successfully.`
    }

    const count = content.split(old_string).length - 1
    if (count === 0) {
      throw new Error(`String to replace not found in file.\nString: ${old_string}`)
    }
    if (count > 1 && !replace_all) {
      throw new Error(
        `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
      )
    }
    const newContent = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, () => new_string)
    await fs.writeFile(fullPath, newContent, 'utf-8')
    return replace_all
      ? `The file ${fullPath} has been updated. All occurrences were successfully replaced.`
      : `The file ${fullPath} has been updated successfully.`
  },
}

// --- run_bash ----------------------------------------------------------------

const runBash: AgentTool = {
  name: 'run_bash',
  description:
    `Executes a given shell command and returns its combined stdout and stderr.

Usage:
- The working directory persists between commands, but shell state (variables, functions, aliases) does not. The shell is initialized from the user's profile.
- Avoid using this tool for tasks a dedicated tool handles better: use Read (not cat/head/tail), Edit (not sed/awk), Write (not echo >/cat <<EOF), Grep (not grep/rg), and Glob (not find/ls). Output text directly instead of echo/printf.
- You may set an optional timeout in milliseconds (default 120000, maximum 600000). Commands that exceed the timeout are terminated and report a timeout exit code.
- Use run_in_background to run a command detached. It returns a task id and an output file path that you read later with Read. Do not append &, and do not poll - you will be notified when it finishes.
- Output longer than 200 lines is truncated and the full output is written to a temporary file whose path is shown in the result.
- Chain dependent commands with &&; issue independent commands as separate parallel tool calls in one message.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      description: { type: 'string', description: 'Optional short label shown in the UI for this command.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000). Ignored when run_in_background is true.' },
      run_in_background: { type: 'boolean', description: 'Run the command detached and return immediately with a task id and output file path. Default false.' },
    },
    required: ['command'],
  },
  execute: async (args, signal) => {
    const { command, timeout, run_in_background } = args as {
      command: string
      description?: string
      timeout?: number
      run_in_background?: boolean
    }

    if (asBoolean(run_in_background)) {
      const outPath = path.join(
        os.tmpdir(),
        `min-agent-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      )
      const fh = await fs.open(outPath, 'w')
      const outFd = fh.fd
      const shell = process.env.SHELL || '/bin/sh'
      const child = spawn(shell, ['-c', command], {
        detached: true,
        stdio: ['ignore', outFd, outFd],
      })
      child.unref()
      const taskId = String(child.pid ?? `bg-${Date.now()}`)
      signal?.addEventListener(
        'abort',
        () => {
          try {
            if (child.pid) process.kill(-child.pid)
          } catch {
            /* already gone */
          }
        },
        { once: true },
      )
      return `Command running in background with ID: ${taskId}. Output is being written to: ${outPath}. Read it with the read_file tool when it finishes.`
    }

    const timeoutMs = Math.min(asNumber(timeout) ?? DEFAULT_TIMEOUT_MS, MAX_FOREGROUND_TIMEOUT_MS)
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        signal,
      })
      const out = cleanOutput(mergeOutput(stdout, stderr))
      return out ? truncateOutput(out) : ''
    } catch (e: unknown) {
      if (signal?.aborted) return '<error>Command was aborted before completion</error>'
      const err = e as NodeJS.ErrnoException & {
        code?: number | string
        stdout?: string
        stderr?: string
        killed?: boolean
        signal?: string
      }
      const out = cleanOutput(mergeOutput(err.stdout ?? '', err.stderr ?? ''))
      let code: string
      if (typeof err.code === 'number') code = String(err.code)
      else if (err.killed && (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
        code = `124 (timed out after ${timeoutMs} ms)`
      } else if (typeof err.code === 'string') code = err.code
      else code = 'unknown'
      const tail = `Exit code ${code}`
      return out ? `${truncateOutput(out)}\n${tail}` : tail
    }
  },
}

// --- grep --------------------------------------------------------------------

const grep: AgentTool = {
  name: 'grep',
  description:
    `A content search tool built on ripgrep.

Usage:
- ALWAYS use this tool for content search. NEVER invoke grep or rg through the Bash tool; this tool is optimized for correct access and behavior.
- The pattern is a JavaScript-style regular expression. Literal regex metacharacters must be escaped - e.g. use interface\\{\\} to match the literal interface{} in Go code.
- Filter files with the glob parameter (e.g. "*.ts", "**/*.tsx") or the type parameter (e.g. "js", "py", "rust").
- Output modes: "content" shows the matching lines (with optional line numbers and surrounding context), "files_with_matches" shows only the matching file paths (this is the default), and "count" shows match counts per file.
- By default patterns match within a single line. For patterns that span lines, set multiline to true.
- Results are paginated with head_limit and offset; the current pagination is reported in the output.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for (JavaScript-style; literal metacharacters must be escaped).' },
      path: { type: 'string', description: 'Directory or file to search in. Defaults to the current working directory.' },
      glob: { type: 'string', description: 'Glob to filter files, e.g. "*.ts" or "**/*.tsx"' },
      type: { type: 'string', description: 'ripgrep file type, e.g. "js", "py", "rust"' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'What to return. Default files_with_matches.' },
      context_before: { type: 'number', description: 'Lines to show before each match (content mode)' },
      context_after: { type: 'number', description: 'Lines to show after each match (content mode)' },
      context: { type: 'number', description: 'Lines to show before and after each match (content mode)' },
      line_numbers: { type: 'boolean', description: 'Show line numbers in content mode. Default true.' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
      head_limit: { type: 'number', description: 'Max lines/entries to return (default 250, 0 = unlimited)' },
      offset: { type: 'number', description: 'Skip this many lines/entries before applying head_limit. Default 0.' },
      multiline: { type: 'boolean', description: 'Allow . to match newlines and patterns to span lines. Default false.' },
    },
    required: ['pattern'],
  },
  execute: async (args, signal) => {
    const a = args as Record<string, unknown>
    const params: GrepParams = {
      pattern: asString(a.pattern),
      path: a.path !== undefined ? asString(a.path) : undefined,
      glob: a.glob !== undefined ? asString(a.glob) : undefined,
      type: a.type !== undefined ? asString(a.type) : undefined,
      output_mode: (a.output_mode as GrepParams['output_mode']) ?? 'files_with_matches',
      context_before: asNumber(a.context_before),
      context_after: asNumber(a.context_after),
      context: asNumber(a.context),
      show_line_numbers: a.line_numbers === undefined ? true : asBoolean(a.line_numbers),
      case_insensitive: asBoolean(a.case_insensitive),
      head_limit: asNumber(a.head_limit),
      offset: asNumber(a.offset),
      multiline: asBoolean(a.multiline),
    }
    const result = await grepSearch(params, signal)
    if (result.mode === 'content') {
      const body = (result.content || 'No matches found')
        .split('\n')
        .map((line) => {
          const i = line.indexOf(':')
          if (i > 0) return toRelative(line.slice(0, i)) + line.slice(i)
          return line
        })
        .join('\n')
      const limitInfo = formatLimitInfo(result.appliedLimit, result.appliedOffset)
      const note = limitInfo ? `\n\n[Showing results with pagination = ${limitInfo}]` : ''
      return body + note
    }
    if (result.mode === 'count') {
      const body = (result.content || 'No matches found')
        .split('\n')
        .map((line) => {
          const i = line.lastIndexOf(':')
          if (i > 0) return toRelative(line.slice(0, i)) + line.slice(i)
          return line
        })
        .join('\n')
      const limitInfo = formatLimitInfo(result.appliedLimit, result.appliedOffset)
      const summary = `\n\nFound ${result.numMatches} total ${plural(result.numMatches, 'occurrence')} across ${result.numFiles} ${plural(result.numFiles, 'file')}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return body + summary
    }
    if (result.numFiles === 0) return 'No files found'
    const limitInfo = formatLimitInfo(result.appliedLimit, result.appliedOffset)
    const filenames = result.filenames.map(toRelative)
    const header = `Found ${result.numFiles} ${plural(result.numFiles, 'file')}${limitInfo ? ` ${limitInfo}` : ''}`
    return `${header}\n${filenames.join('\n')}`
  },
}

// --- glob --------------------------------------------------------------------

const glob: AgentTool = {
  name: 'glob',
  description:
    `Fast file pattern matching by name, backed by ripgrep.

Usage:
- ALWAYS use this tool to find files by name. NEVER invoke find or ls through the Bash tool.
- The pattern is a glob (e.g. "**/*.ts", "src/**/*.tsx"). An optional path limits the search directory and defaults to the current working directory.
- Matching files are sorted by modification time (newest first) and capped at 100 results. When more files match, the result is marked as truncated and you should use a more specific path or pattern.
- Use this tool when you need to locate files by name; for searching file contents, use the Grep tool instead.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "**/*.ts").' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the current working directory.' },
    },
    required: ['pattern'],
  },
  execute: async (args, signal) => {
    const a = args as { pattern: string; path?: string }
    const cwd = a.path ? asString(a.path) : process.cwd()
    const { files, truncated } = await globSearch(a.pattern, cwd, { limit: GLOB_LIMIT, offset: 0 }, signal)
    if (files.length === 0) return 'No files found'
    const tail = truncated ? '\n(Results are truncated. Consider using a more specific path or pattern.)' : ''
    return files.map(toRelative).join('\n') + tail
  },
}

// --- registry ----------------------------------------------------------------

export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash, grep, glob]
}
