#!/usr/bin/env node
// End-to-end smoke test: launch the built binary in a fixed-size tmux
// session, send keys, and assert the captured pane — no manual verification.
// Run `npm run build` first (or `npm run smoke` which builds).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'dist', 'cli.js')

const COLS = 80
const ROWS = 24
const SESSION = `min-agent-smoke-${process.pid}`

let failures = 0

function fail(message, output) {
  failures += 1
  console.error(`FAIL: ${message}`)
  if (output !== undefined) {
    console.error('----- captured pane -----')
    console.error(output)
    console.error('-------------------------')
  }
}

function tmux(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' })
  if (r.error) throw new Error(`tmux ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`)
  return r.stdout
}

function capture() {
  return tmux(['capture-pane', '-p', '-e', '-t', SESSION])
}

// Strip OSC (title / clipboard / hyperlinks), APC (cursor marker), and CSI.
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b_[^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Poll capture-pane until `predicate` matches or the timeout elapses, so a
// slow first paint (Kitty probe fallback, throttled render) does not flake.
async function waitFor(predicate, timeoutMs = 4000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pane = capture()
    if (predicate(pane)) return pane
    await sleep(intervalMs)
  }
  return null
}

function assertContains(label, haystack, needle) {
  if (!haystack.includes(needle)) fail(`${label} (expected to contain ${JSON.stringify(needle)})`, haystack)
}

async function main() {
  const check = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
  if (check.error || check.status !== 0) {
    console.error('tmux is required for the smoke test (install it or run inside a tmux-capable CI runner).')
    process.exit(1)
  }
  const binCheck = spawnSync('node', ['--check', BIN], { encoding: 'utf8' })
  if (binCheck.error || binCheck.status !== 0) {
    console.error(`built binary missing or invalid at ${BIN} — run \`npm run build\` first.`)
    process.exit(1)
  }

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'min-agent-smoke-'))
  try {
    // Fixed-size session so layout assertions are deterministic
    tmux(['new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS)])
    // Isolate the session file from the real ~/.min-agent
    const cmd = `HOME='${tmpHome}' MIN_AGENT_API_KEY='' node '${BIN}'`
    tmux(['send-keys', '-t', SESSION, cmd, 'Enter'])
  } catch (e) {
    console.error(`setup failed: ${e.message}`)
    try { tmux(['kill-session', '-t', SESSION]) } catch { /* already gone */ }
    rmSync(tmpHome, { recursive: true, force: true })
    process.exit(1)
  }

  // --- Boot screen -------------------------------------------------------
  const boot = await waitFor((pane) => {
    const text = stripAnsi(pane)
    return text.includes('min-agent') && text.includes('glm-5.2') && text.includes('type to start')
  })
  if (!boot) {
    fail('boot screen never painted (min-agent / glm-5.2 / type to start)')
  } else {
    const text = stripAnsi(boot)
    const screenLines = text.replace(/\n$/, '').split('\n')
    assertContains('header wordmark', text, 'min-agent')
    assertContains('header model', text, 'glm-5.2')
    assertContains('header start hint', text, 'type to start')
    assertContains('input prompt', text, '>')
    if (screenLines.length !== ROWS) {
      fail(`pane should be ${ROWS} rows, captured ${screenLines.length}`)
    }
    for (let i = 0; i < screenLines.length; i++) {
      const width = screenLines[i].length
      if (width > COLS) fail(`row ${i} exceeds ${COLS} columns (${width})`)
    }
  }

  // --- Typing into the input --------------------------------------------
  tmux(['send-keys', '-t', SESSION, 'hello'])
  await sleep(300)
  const typed = stripAnsi(capture())
  assertContains('input echoes typed text', typed, 'hello')

  // --- Backspace ---------------------------------------------------------
  tmux(['send-keys', '-t', SESSION, 'BSPACE'])
  await sleep(300)
  const backspaced = stripAnsi(capture())
  assertContains('backspace removes one character', backspaced, 'hell')
  if (backspaced.includes('hello')) fail('backspace did not remove the last character')

  // --- Overlong input stays within the terminal width -------------------
  tmux(['send-keys', '-t', SESSION, 'x'.repeat(COLS)])
  await sleep(300)
  const overlongText = stripAnsi(capture())
  for (const line of overlongText.replace(/\n$/, '').split('\n')) {
    if (line.length > COLS) fail(`overlong input row exceeds ${COLS} columns (${line.length})`)
  }

  // --- Cleanup -----------------------------------------------------------
  tmux(['kill-session', '-t', SESSION])
  rmSync(tmpHome, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\nsmoke: ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('smoke: tmux end-to-end assertions passed')
}

main().catch((e) => {
  console.error(`smoke: unexpected error: ${e.message}`)
  process.exit(1)
})
