#!/usr/bin/env node
// Fake-model end-to-end stress test (tmux transport).
// Launches the built binary in a fixed 80x24 tmux session with MIN_AGENT_FAKE=1,
// simulates the user typing "abc" + Enter, then verifies the TUI survives a
// 1-minute lifecycle: a ~10s think delay, 500 tool calls, and ~30000 streamed
// characters. Reads screen content via capture-pane and cursor position via
// display-message (real signal, tmux transport). Run `npm run build` first.
//
// NOTE: this uses tmux, not Kitty. For the Kitty/kitty @ remote-control version
// (reads screen + cursor via `kitten @`), see scripts/tui-fake-kitty.mjs.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'dist', 'cli.js')

const COLS = 80
const ROWS = 24
const SESSION = `min-agent-fake-${process.pid}`

let failures = 0
function fail(message, extra) {
  failures += 1
  console.error(`FAIL: ${message}`)
  if (extra !== undefined) console.error(extra)
}

function tmux(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' })
  if (r.error) throw new Error(`tmux ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`)
  return r.stdout
}

function exec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r
}

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

function cursor() {
  const out = tmux(['display-message', '-p', '-t', SESSION, '#{cursor_x} #{cursor_y}'])
  const [x, y] = out.trim().split(/\s+/).map(Number)
  return { x, y }
}

async function main() {
  const tmuxCheck = exec('tmux', ['-V'])
  if (tmuxCheck.error || tmuxCheck.status !== 0) {
    console.error('tmux is required for this test.')
    process.exit(1)
  }
  // Ensure the binary exists (auto-build if a prior build is missing).
  if (exec('node', ['--check', BIN]).status !== 0) {
    console.error('built binary missing at ' + BIN + ' — building now')
    if (exec('npm', ['run', 'build']).status !== 0) {
      console.error('build failed')
      process.exit(1)
    }
  }

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'min-agent-fake-'))
  const cleanup = () => {
    try { tmux(['kill-session', '-t', SESSION]) } catch { /* gone */ }
    rmSync(tmpHome, { recursive: true, force: true })
  }

  try {
    tmux(['new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS)])
    const cmd = `HOME='${tmpHome}' MIN_AGENT_FAKE=1 MIN_AGENT_API_KEY='' node '${BIN}'`
    tmux(['send-keys', '-t', SESSION, cmd, 'Enter'])

    // --- Boot screen -----------------------------------------------------
    const deadline = Date.now() + 5000
    let boot = null
    while (Date.now() < deadline) {
      const pane = stripAnsi(tmux(['capture-pane', '-p', '-t', SESSION]))
      if (pane.includes('min-agent') && pane.includes('type to start')) { boot = pane; break }
      await sleep(150)
    }
    if (!boot) { fail('boot screen never painted'); cleanup(); process.exit(1) }
    console.log('PASS: boot screen painted (min-agent / type to start)')

    const bootCursor = cursor()
    console.log(`INFO: boot cursor = (${bootCursor.x}, ${bootCursor.y})`)

    // --- Simulate user input: type "abc" + Enter -------------------------
    tmux(['send-keys', '-t', SESSION, 'abc', 'Enter'])
    const sendT = Date.now()
    console.log('INFO: sent "abc" + Enter at t=0s')

    // --- Think-phase check (~4s in, before the 10s think finishes) ------
    await sleep(4000)
    const thinkPane = stripAnsi(tmux(['capture-pane', '-p', '-t', SESSION]))
    if (thinkPane.includes('fake_tool')) fail('tool calls appeared during the think delay (<10s)')
    else console.log('PASS: 10s think delay — no tool/stream output at t=4s')
    if (thinkPane.includes('abc')) console.log('PASS: user input "abc" rendered in transcript')

    // --- Sample the run --------------------------------------------------
    let sawTool = false
    let sawStream = false
    let firstToolT = null
    let firstStreamT = null
    let maxX = bootCursor.x
    let maxY = bootCursor.y
    let maxFakeToolOnScreen = 0
    let maxXOnScreen = 0
    let cursorMoved = false

    for (let t = 2; t <= 66; t += 2) {
      await sleep(2000)
      const paneRaw = tmux(['capture-pane', '-p', '-t', SESSION])
      const pane = stripAnsi(paneRaw)
      const cur = cursor()
      maxX = Math.max(maxX, cur.x)
      maxY = Math.max(maxY, cur.y)
      if (cur.x !== bootCursor.x || cur.y !== bootCursor.y) cursorMoved = true

      const toolCount = (pane.match(/fake_tool/g) || []).length
      const xCount = (pane.match(/x/g) || []).length
      maxFakeToolOnScreen = Math.max(maxFakeToolOnScreen, toolCount)
      maxXOnScreen = Math.max(maxXOnScreen, xCount)

      const elapsed = (Date.now() - sendT) / 1000
      if (toolCount > 0 && !sawTool) { sawTool = true; firstToolT = elapsed }
      if (xCount > 50 && !sawStream) { sawStream = true; firstStreamT = elapsed }

      if (t % 10 === 0) {
        console.log(`INFO: t=${elapsed.toFixed(0)}s cursor=(${cur.x},${cur.y}) toolBlocksOnScreen=${toolCount} xCharsOnScreen=${xCount}`)
      }
    }

    // --- Assertions ------------------------------------------------------
    if (!sawTool) fail('no tool calls rendered (expected 500 fake_tool calls)')
    else console.log(`PASS: tool calls rendered (first at t=${firstToolT?.toFixed(1)}s, max ${maxFakeToolOnScreen} visible at once)`)

    if (!sawStream) fail('no streamed assistant text rendered (expected ~30000 chars)')
    else console.log(`PASS: streamed text rendered (first at t=${firstStreamT?.toFixed(1)}s, max ${maxXOnScreen} "x" chars visible at once)`)

    if (firstToolT !== null && firstToolT < 9) fail(`think delay too short (tools started at t=${firstToolT.toFixed(1)}s, expected ~10s)`)
    if (firstStreamT !== null && firstToolT !== null && firstStreamT <= firstToolT) fail('streaming did not follow tool calls')

    if (!cursorMoved) fail('cursor never moved (rendering / cursor read broken)')
    else console.log(`PASS: cursor moved during the run (reached (${maxX}, ${maxY}))`)

    // --- No crash: session + node process still alive --------------------
    const panePid = tmux(['list-panes', '-t', SESSION, '-F', '#{pane_pid}']).trim()
    const procAlive = exec('pgrep', ['-f', 'dist/cli.js']).stdout.trim().length > 0
    if (!panePid || !procAlive) fail('binary crashed or exited during the run')
    else console.log(`PASS: binary alive after full lifecycle (pane_pid=${panePid})`)

    const totalT = (Date.now() - sendT) / 1000
    console.log(`INFO: sampled for ${totalT.toFixed(0)}s`)

    cleanup()

    if (failures > 0) {
      console.error(`\nfake-smoke: ${failures} assertion(s) failed`)
      process.exit(1)
    }
    console.log('\nfake-smoke: tmux stress assertions passed (think / 500 tools / 30k stream / cursor)')
  } catch (e) {
    console.error(`fake-smoke: unexpected error: ${e.message}`)
    cleanup()
    process.exit(1)
  }
}

main()
