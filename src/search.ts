// src/search.ts
// Search backends for the grep and glob tools.
//
// Both are ripgrep-backed (mirrors how the reference tools invoke `rg`), with a
// pure-Node fallback when `rg` is not installed. Results are plain strings so
// the tool layer stays free of structured output.
//
// The grep/glob argument mapping and result ordering follow the reference
// tools: --hidden + VCS exclusion, --max-columns 500, exit 1 = no matches,
// files_with_matches sorted newest-first by mtime (test mode: by name), and
// glob sorted by --sort=modified (oldest-first).

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'

const RG_TIMEOUT_MS = 20_000
const RG_MAX_BUFFER = 20 * 1024 * 1024
const DEFAULT_HEAD_LIMIT = 250

// VCS directories are excluded from searches to avoid noise from metadata.
const VCS_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
// Skipped in the Node fallback to keep tree walks bounded.
const FALLBACK_SKIP_DIRS = new Set([...VCS_DIRECTORIES, 'node_modules'])

export interface GrepParams {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  context_before?: number
  context_after?: number
  context?: number
  show_line_numbers?: boolean
  case_insensitive?: boolean
  head_limit?: number
  offset?: number
  multiline?: boolean
}

export type GrepOutput =
  | { mode: 'content'; content: string; numLines: number; appliedLimit?: number; appliedOffset?: number }
  | { mode: 'files_with_matches'; filenames: string[]; numFiles: number; appliedLimit?: number; appliedOffset?: number }
  | { mode: 'count'; content: string; numMatches: number; numFiles: number; appliedLimit?: number; appliedOffset?: number }

export interface GlobOptions {
  limit: number
  offset: number
}

// Parse rg stdout into trimmed, non-empty lines. Mirrors the reference tool's
// parse step (trim, split on newline, strip a trailing CR, drop empties).
function parseLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
}

// Run ripgrep. Resolves with lines on success, [] on exit 1 (no matches),
// and rejects with code ENOENT when rg is missing (so the caller can fall back).
//
// The EAGAIN single-thread retry and the "abort is not an error" handling
// mirror the reference tool's ripGrep wrapper.
function runRg(args: string[], target: string, signal?: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const run = (extra: string[], isRetry: boolean): void => {
      execFile(
        'rg',
        [...args, ...extra, target],
        { maxBuffer: RG_MAX_BUFFER, signal, timeout: RG_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(parseLines(stdout))
            return
          }
          const code = (err as { code?: unknown }).code
          // Aborted searches are cancellations, not failures — resolve rather
          // than throw, matching the reference tool's ABORT_ERR handling.
          if (signal?.aborted || code === 'ABORT_ERR') {
            resolve(parseLines(stdout))
            return
          }
          if (code === 1) {
            // ripgrep exit 1 = no matches; treat as success with empty result.
            resolve([])
            return
          }
          if (code === 'ENOENT') {
            const e = err as NodeJS.ErrnoException
            e.code = 'ENOENT'
            reject(e)
            return
          }
          // Under resource pressure ripgrep can fail with EAGAIN (too many
          // threads). Retry once single-threaded, as the reference tool does.
          if (
            !isRetry &&
            typeof stderr === 'string' &&
            (stderr.includes('os error 11') || stderr.includes('Resource temporarily unavailable'))
          ) {
            run(['-j', '1'], true)
            return
          }
          reject(err)
        },
      )
    }
    run([], false)
  })
}

// Build the rg argument list from structured grep params (copied shape from the
// reference tool's call mapping).
function buildRgArgs(p: GrepParams): string[] {
  const args = ['--hidden']
  for (const dir of VCS_DIRECTORIES) args.push('--glob', `!${dir}`)
  args.push('--max-columns', '500')

  const outputMode = p.output_mode ?? 'files_with_matches'
  if (p.multiline) args.push('-U', '--multiline-dotall')
  if (p.case_insensitive) args.push('-i')

  if (outputMode === 'files_with_matches') args.push('-l')
  else if (outputMode === 'count') args.push('-c')

  if (p.show_line_numbers !== false && outputMode === 'content') args.push('-n')

  if (outputMode === 'content') {
    if (p.context !== undefined) args.push('-C', String(p.context))
    else {
      if (p.context_before !== undefined) args.push('-B', String(p.context_before))
      if (p.context_after !== undefined) args.push('-A', String(p.context_after))
    }
  }

  if (p.pattern.startsWith('-')) args.push('-e', p.pattern)
  else args.push(p.pattern)

  if (p.type) args.push('--type', p.type)

  if (p.glob) {
    const patterns: string[] = []
    for (const raw of p.glob.split(/\s+/)) {
      if (raw.includes('{') && raw.includes('}')) patterns.push(raw)
      else patterns.push(...raw.split(',').filter(Boolean))
    }
    for (const g of patterns.filter(Boolean)) args.push('--glob', g)
  }

  return args
}

function applyHeadLimit<T>(items: T[], limit: number | undefined, offset: number): { items: T[]; appliedLimit?: number } {
  if (limit === 0) return { items: items.slice(offset) }
  const effective = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effective)
  const truncated = items.length - offset > effective
  return { items: sliced, appliedLimit: truncated ? effective : undefined }
}

// Sort files by modification time. files_with_matches uses descending (newest
// first); glob uses ascending to match `rg --sort=modified`. Under NODE_ENV=test
// we sort by filename for deterministic output, mirroring the reference tool.
async function sortFilesByMtime(files: string[], cwd: string, ascending: boolean): Promise<string[]> {
  if (process.env.NODE_ENV === 'test') {
    return [...files].sort((a, b) => a.localeCompare(b))
  }
  const resolved = files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)))
  const stats = await Promise.allSettled(resolved.map((f) => stat(f)))
  return files
    .map((f, i) => [f, stats[i]!.status === 'fulfilled' ? (stats[i]!.value.mtimeMs ?? 0) : 0] as const)
    .sort((a, b) => (ascending ? a[1] - b[1] : b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map((x) => x[0])
}

// --- Node fallback for grep ---------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i)
      if (end > i) {
        re += '[' + glob.slice(i + 1, end).replace(/[^\]\-\w]/g, '\\$&') + ']'
        i = end
      } else re += '\\['
    } else if ('.+^${}()|\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

async function walkFiles(root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && VCS_DIRECTORIES.includes(e.name)) continue
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (FALLBACK_SKIP_DIRS.has(e.name)) continue
      await walkFiles(full, out)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function nodeGrep(p: GrepParams, target: string, signal?: AbortSignal): Promise<GrepOutput> {
  const outputMode = p.output_mode ?? 'files_with_matches'
  const flags = p.case_insensitive ? 'i' : ''
  const regex = p.multiline ? new RegExp(p.pattern, `m${flags}`) : new RegExp(p.pattern, flags)
  const globRe = p.glob ? globToRegExp(p.glob) : null

  const allFiles: string[] = []
  // Support pointing grep at a single file as well as a directory. walkFiles
  // walks with readdir, which fails on plain files, so short-circuit those.
  const st = await stat(target).catch(() => null)
  if (st?.isFile()) {
    allFiles.push(target)
  } else {
    await walkFiles(target, allFiles)
  }

  if (outputMode === 'files_with_matches') {
    const matches: string[] = []
    for (const file of allFiles) {
      if (signal?.aborted) break
      if (globRe && !globRe.test(path.basename(file))) continue
      try {
        const buf = await readFile(file)
        if (looksBinary(buf)) continue
        if (regex.test(buf.toString('utf-8'))) matches.push(file)
      } catch {
        /* skip unreadable */
      }
    }
    const sorted = await sortFilesByMtime(matches, target, false)
    const { items, appliedLimit } = applyHeadLimit(sorted, p.head_limit, p.offset ?? 0)
    return { mode: 'files_with_matches', filenames: items, numFiles: items.length, ...(appliedLimit !== undefined && { appliedLimit }), ...(p.offset ? { appliedOffset: p.offset } : {}) }
  }

  if (outputMode === 'count') {
    const lines: string[] = []
    let total = 0
    let fileCount = 0
    for (const file of allFiles) {
      if (signal?.aborted) break
      if (globRe && !globRe.test(path.basename(file))) continue
      try {
        const buf = await readFile(file)
        if (looksBinary(buf)) continue
        const text = buf.toString('utf-8')
        // Global flag is required for counting every occurrence; the shared
        // regex omits it so .test() has no lastIndex side effects elsewhere.
        const count = (text.match(new RegExp(regex.source, regex.flags + 'g')) || []).length
        if (count > 0) {
          lines.push(`${file}:${count}`)
          total += count
          fileCount++
        }
      } catch {
        /* skip */
      }
    }
    const { items, appliedLimit } = applyHeadLimit(lines, p.head_limit, p.offset ?? 0)
    return { mode: 'count', content: items.join('\n'), numMatches: total, numFiles: fileCount, ...(appliedLimit !== undefined && { appliedLimit }), ...(p.offset ? { appliedOffset: p.offset } : {}) }
  }

  // content mode
  const out: string[] = []
  for (const file of allFiles) {
    if (signal?.aborted) break
    if (globRe && !globRe.test(path.basename(file))) continue
    let buf
    try {
      buf = await readFile(file)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const text = buf.toString('utf-8')
    const fileLines = text.split('\n')
    const matched: number[] = []
    fileLines.forEach((line, idx) => {
      if (regex.test(line)) matched.push(idx)
    })
    // Dedupe context lines so overlapping -B/-A/-C windows don't repeat a line,
    // matching how `rg` emits each line once even when contexts overlap.
    const seen = new Set<number>()
    const from = p.context_before ?? p.context ?? 0
    const to = p.context_after ?? p.context ?? 0
    for (const idx of matched) {
      for (let j = idx - from; j <= idx + to; j++) {
        if (j < 0 || j >= fileLines.length) continue
        if (seen.has(j)) continue
        seen.add(j)
        const prefix = p.show_line_numbers !== false ? `${file}:${j + 1}:` : `${file}:`
        out.push(prefix + fileLines[j])
      }
    }
  }
  const { items, appliedLimit } = applyHeadLimit(out, p.head_limit, p.offset ?? 0)
  return { mode: 'content', content: items.join('\n'), numLines: items.length, ...(appliedLimit !== undefined && { appliedLimit }), ...(p.offset ? { appliedOffset: p.offset } : {}) }
}

// --- Public API --------------------------------------------------------------

export async function grepSearch(params: GrepParams, signal?: AbortSignal): Promise<GrepOutput> {
  // Resolve to an absolute path so rg returns absolute paths and the caller can
  // stat them; the reference tool always passes an absolute path to rg.
  const target = path.resolve(params.path ?? process.cwd())
  const args = buildRgArgs(params)
  try {
    const lines = await runRg(args, target, signal)
    return formatRgResult(params, lines, target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return nodeGrep(params, target, signal)
    }
    throw e
  }
}

async function formatRgResult(p: GrepParams, lines: string[], target: string): Promise<GrepOutput> {
  const outputMode = p.output_mode ?? 'files_with_matches'
  const offset = p.offset ?? 0

  if (outputMode === 'content') {
    const { items, appliedLimit } = applyHeadLimit(lines, p.head_limit, offset)
    return { mode: 'content', content: items.join('\n'), numLines: items.length, ...(appliedLimit !== undefined && { appliedLimit }), ...(offset > 0 && { appliedOffset: offset }) }
  }

  if (outputMode === 'count') {
    const { items, appliedLimit } = applyHeadLimit(lines, p.head_limit, offset)
    let total = 0
    let fileCount = 0
    for (const line of items) {
      const ci = line.lastIndexOf(':')
      const n = ci > 0 ? parseInt(line.slice(ci + 1), 10) : NaN
      if (!isNaN(n)) {
        total += n
        fileCount++
      }
    }
    return { mode: 'count', content: items.join('\n'), numMatches: total, numFiles: fileCount, ...(appliedLimit !== undefined && { appliedLimit }), ...(offset > 0 && { appliedOffset: offset }) }
  }

  // files_with_matches: sort by modification time (newest first), like the
  // reference tool. Under NODE_ENV=test this sorts by name for determinism.
  const sorted = await sortFilesByMtime(lines, target, false)
  const { items, appliedLimit } = applyHeadLimit(sorted, p.head_limit, offset)
  return { mode: 'files_with_matches', filenames: items, numFiles: items.length, ...(appliedLimit !== undefined && { appliedLimit }), ...(offset > 0 && { appliedOffset: offset }) }
}

// --- Glob --------------------------------------------------------------------

async function runRgGlob(pattern: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const args = ['--files', '--glob', pattern, '--sort=modified', '--no-ignore', '--hidden']
  return runRg(args, cwd, signal)
}

async function nodeGlob(pattern: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const re = globToRegExp(pattern)
  const all: string[] = []
  await walkFiles(cwd, all)
  // Glob patterns are relative to the search root; walkFiles yields absolute
  // paths, so test against the path relative to cwd.
  const matched = all.filter((f) => re.test(path.relative(cwd, f)))
  // Mirror rg --sort=modified (oldest first) for a consistent ordering.
  return sortFilesByMtime(matched, cwd, true)
}

export async function globSearch(
  pattern: string,
  cwd: string,
  opts: GlobOptions,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const root = path.resolve(cwd)
  let files: string[]
  try {
    const lines = await runRgGlob(pattern, root, signal)
    files = lines
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      files = await nodeGlob(pattern, root, signal)
    } else {
      throw e
    }
  }
  const truncated = files.length > opts.offset + opts.limit
  const sliced = files.slice(opts.offset, opts.offset + opts.limit)
  return { files: sliced, truncated }
}
