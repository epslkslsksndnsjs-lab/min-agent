// src/tools.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { builtinTools } from './tools.js'

const tools = Object.fromEntries(builtinTools().map((t) => [t.name, t]))

let dir: string

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'min-agent-tools-'))
  await write('a.txt', 'hello world\nfoo bar\nbaz\n')
  await write('sub/b.ts', 'export const x = 1\nexport function run() { return "run" }\n')
  await write('sub/c.ts', 'const y = 2\n')
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('builtinTools registry', () => {
  it('exposes the six upgraded tools', () => {
    expect(Object.keys(tools).sort()).toEqual(
      ['edit', 'glob', 'grep', 'read_file', 'run_bash', 'write_file'].sort(),
    )
  })
})

describe('read_file', () => {
  it('reads a slice with 1-based offset and limit, with line numbers', async () => {
    const out = await tools.read_file.execute({ path: path.join(dir, 'a.txt'), offset: 2, limit: 1 })
    expect(out).toBe('     2→foo bar')
  })

  it('reads the whole file by default with 1-based line numbers', async () => {
    const out = await tools.read_file.execute({ path: path.join(dir, 'a.txt') })
    expect(out).toBe('     1→hello world\n     2→foo bar\n     3→baz')
  })

  it('gives a friendly error for a missing file', async () => {
    await expect(
      tools.read_file.execute({ path: path.join(dir, 'does-not-exist.txt') }),
    ).rejects.toThrow(/File does not exist/)
  })

  it('refuses files larger than 256 KB unless a slice is requested', async () => {
    const big = path.join(dir, 'big.txt')
    // Multi-line content so a single-line slice is genuinely small.
    await fs.writeFile(big, Array.from({ length: 40000 }, (_, i) => `line ${i}`).join('\n'))
    await expect(tools.read_file.execute({ path: big })).rejects.toThrow(
      /exceeds maximum allowed size/,
    )
    // With a limit the slice is served (size cap skipped), so it should not throw.
    const out = await tools.read_file.execute({ path: big, offset: 1, limit: 1 })
    expect(out).toBe('     1→line 0')
  })

  it('refuses binary files', async () => {
    const bin = path.join(dir, 'bin.dat')
    await fs.writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await expect(tools.read_file.execute({ path: bin })).rejects.toThrow(
      /cannot read binary files/,
    )
  })
})

describe('edit', () => {
  it('replaces a unique match', async () => {
    const f = path.join(dir, 'edit-once.txt')
    await fs.writeFile(f, 'alpha beta alpha\n')
    await tools.edit.execute({ path: f, old_string: 'beta', new_string: 'gamma' })
    expect(await fs.readFile(f, 'utf-8')).toBe('alpha gamma alpha\n')
  })

  it('replaces all when replace_all is true', async () => {
    const f = path.join(dir, 'edit-all.txt')
    await fs.writeFile(f, 'a X b X c\n')
    await tools.edit.execute({ path: f, old_string: 'X', new_string: 'Y', replace_all: true })
    expect(await fs.readFile(f, 'utf-8')).toBe('a Y b Y c\n')
  })

  it('errors when old_string is not unique without replace_all', async () => {
    const f = path.join(dir, 'edit-dup.txt')
    await fs.writeFile(f, 'X y X\n')
    await expect(
      tools.edit.execute({ path: f, old_string: 'X', new_string: 'Z' }),
    ).rejects.toThrow(/unique|replace_all/)
  })

  it('errors when old_string equals new_string', async () => {
    const f = path.join(dir, 'edit-same.txt')
    await fs.writeFile(f, 'keep\n')
    await expect(
      tools.edit.execute({ path: f, old_string: 'keep', new_string: 'keep' }),
    ).rejects.toThrow(/No changes to make/)
  })

  it('creates a new file when old_string is empty and the file is missing', async () => {
    const f = path.join(dir, 'edit-create.txt')
    await tools.edit.execute({ path: f, old_string: '', new_string: 'fresh\n' })
    expect(await fs.readFile(f, 'utf-8')).toBe('fresh\n')
  })
})

describe('grep (rg-backed; node fallback when rg missing)', () => {
  it('files_with_matches returns matching paths', async () => {
    const out = await tools.grep.execute({ pattern: 'export', path: dir })
    expect(out).toContain('b.ts')
    expect(out).not.toContain('a.txt')
  })

  it('content mode returns matching lines', async () => {
    const out = await tools.grep.execute({ pattern: 'run', path: dir, output_mode: 'content' })
    expect(out).toContain('run')
  })

  it('count mode reports totals', async () => {
    const out = await tools.grep.execute({ pattern: 'export', path: dir, output_mode: 'count' })
    expect(out).toMatch(/Found \d+ total occurrences across \d+ files?/)
  })

  it('glob filter narrows the search', async () => {
    const out = await tools.grep.execute({ pattern: 'export', path: dir, glob: '*.ts' })
    expect(out).toContain('b.ts')
  })
})

describe('glob (node fallback)', () => {
  it('finds files by pattern', async () => {
    const out = await tools.glob.execute({ pattern: '**/*.ts', path: dir })
    expect(out).toContain('b.ts')
    expect(out).toContain('c.ts')
    expect(out).not.toContain('a.txt')
  })
})

describe('run_bash', () => {
  it('runs a foreground command and returns output', async () => {
    const out = await tools.run_bash.execute({ command: 'echo hello-from-bash' })
    expect(out).toContain('hello-from-bash')
  })

  it('runs in the background and writes output to a file', async () => {
    const out = await tools.run_bash.execute({ command: 'echo bg-output', run_in_background: true })
    const match = out.match(/Output is being written to: (\S+)\./)
    expect(match).not.toBeNull()
    const outPath = match![1]
    // Poll until the detached process writes its output.
    let content = ''
    for (let i = 0; i < 50; i++) {
      try {
        content = await fs.readFile(outPath, 'utf-8')
        if (content.includes('bg-output')) break
      } catch {
        /* not written yet */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(content).toContain('bg-output')
    await fs.rm(outPath, { force: true })
  })

  it('appends the exit code on a non-zero exit', async () => {
    const out = await tools.run_bash.execute({ command: 'exit 3' })
    expect(out).toContain('Exit code 3')
  })

  it('returns an aborted marker when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await tools.run_bash.execute({ command: 'sleep 1' }, ac.signal)
    expect(out).toContain('Command was aborted before completion')
  })
})
