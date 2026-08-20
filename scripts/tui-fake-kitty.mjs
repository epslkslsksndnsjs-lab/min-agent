#!/usr/bin/env node
// Fake-model end-to-end stress test (real Kitty + remote-control protocol).
//
// Starts a genuine Kitty instance listening on a unix socket, launches the
// built binary inside a Kitty window, simulates the user typing "abc" + Enter,
// then verifies the TUI survives a ~30 minute lifecycle driven entirely by the
// fake agent:
//   - a ~10s think delay per turn (no output)
//   - 500 tool calls (every 7th fails -> red X)
//   - ~30000 streamed characters
//   - a "You:" interjection every 200 streamed chars
//
// Screen content is read with `kitten @ get-text`; color data with
// `get-text --ansi`; cursor position with `get-text --add-cursor` (parsed from
// the trailing CSI escape). Run `npm run build` first.
//
// Env overrides (match run-agent-fake.ts):
//   FAKE_LIFECYCLE_MS, FAKE_TOOL_TARGET, FAKE_CHAR_TARGET, FAKE_INTERJECT_EVERY
//
// Usage:
//   node scripts/tui-fake-kitty.mjs            # spawns its own Kitty on a socket
//   node scripts/tui-fake-kitty.mjs --no-spawn # target an already-running Kitty
//                                        via --to unix:/path/to/sock

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'dist', 'cli.js')

const noSpawn = process.argv.includes('--no-spawn')
const toIdx = process.argv.indexOf('--to')
let TO = toIdx >= 0 ? process.argv[toIdx + 1] : undefined

let failures = 0
function fail(message, extra) {
  failures += 1
  console.error(`FAIL: ${message}`)
  if (extra !== undefined) console.error(extra)
}
function pass(message) {
  console.log(`PASS: ${message}`)
}
function kitten(args) {
  const full = TO ? ['--to', TO.startsWith('unix:') || TO.startsWith('tcp:') ? TO : `unix:${TO}`, ...args] : args
  const r = spawnSync('kitten', ['@', ...full], { encoding: 'utf8' })
  if (r.error) throw new Error(`kitten @ ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`kitten @ ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`)
  return r.stdout
}
function exec(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' })
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
// Parse the cursor position Kitty appends via --add-cursor (CSI "<row>;<col>H").
function parseCursor(text) {
  const m = text.match(/\x1b\[(\d+);(\d+)H(?![\s\S]*\x1b\[\d+;\d+H)/)
  if (!m) return null
  return { x: Number(m[2]), y: Number(m[1]) }
}

// Color markers (from theme.ts) we expect on a styled tool header line.
const GREEN = '\x1b[32m' // success / done check
const RED = '\x1b[31m' // error X

async function main() {
  if (exec('kitten', ['--version']).status !== 0) {
    console.error('kitten is required. Install Kitty first.')
    process.exit(1)
  }
  if (exec('node', ['--check', BIN]).status !== 0) {
    console.error('built binary missing at ' + BIN + ' — building now')
    if (exec('npm', ['run', 'build']).status !== 0) { console.error('build failed'); process.exit(1) }
  }

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'min-agent-fake-'))
  let sock = TO
  let kittyProc = null
  if (!noSpawn) {
    sock = path.join(tmpHome, 'kitty-rc.sock')
    const sockAddr = `unix:${sock}`
    if (existsSync(sock)) rmSync(sock, { force: true })
    kittyProc = spawn(
      'kitty',
      [
        '--listen-on', sockAddr,
        '-o', 'allow_remote_control=yes',
        '-o', 'window_title_template=min-agent-fake',
        'sh', '-c', 'sleep 3600',
      ],
      { stdio: 'ignore', detached: false },
    )
    // Wait for the socket to come up.
    for (let i = 0; i < 50; i++) {
      if (existsSync(sock)) break
      await sleep(100)
    }
    if (!existsSync(sock)) { console.error('Kitty socket never appeared'); process.exit(1) }
    TO = sockAddr
  }
  const match = 'title:min-agent-fake'

  const cleanup = () => {
    try { kitten(['close-window', '-m', match]) } catch { /* gone */ }
    try { if (kittyProc) kittyProc.kill('SIGTERM') } catch { /* gone */ }
    rmSync(tmpHome, { recursive: true, force: true })
  }

  try {
    // --- Boot screen -----------------------------------------------------
    const wid = kitten(['launch', '--to', TO, '--title', 'min-agent-fake', 'env', `HOME=${tmpHome}`, 'MIN_AGENT_FAKE=1', 'node', BIN]).trim()
    console.log(`INFO: launched Kitty window id=${wid}`)

    const deadline = Date.now() + 5000
    let boot = null
    while (Date.now() < deadline) {
      const pane = stripAnsi(kitten(['get-text', '-m', match]))
      if (pane.includes('min-agent') && pane.includes('type to start')) { boot = pane; break }
      await sleep(150)
    }
    if (!boot) { fail('boot screen never painted'); cleanup(); process.exit(1) }
    pass('boot screen painted (min-agent / type to start)')

    const bootCursor = parseCursor(kitten(['get-text', '-m', match, '--add-cursor'])) || { x: 0, y: 0 }
    console.log(`INFO: boot cursor = (${bootCursor.x}, ${bootCursor.y})`)

    // --- Simulate user input: type "abc" + Enter -------------------------
    kitten(['send-text', '-m', match, 'abc'])
    kitten(['send-key', '-m', match, 'Enter'])
    const sendT = Date.now()
    console.log('INFO: sent "abc" + Enter at t=0s')

    // --- Think-phase check (~4s in) -------------------------------------
    await sleep(4000)
    const thinkPane = stripAnsi(kitten(['get-text', '-m', match]))
    if (thinkPane.includes('fake_tool')) fail('tool calls appeared during the think delay (<10s)')
    else pass('10s think delay — no tool/stream output at t=4s')
    if (thinkPane.includes('abc')) pass('user input "abc" rendered in transcript')
    else fail('user input "abc" not rendered in transcript')

    // --- Sample the run --------------------------------------------------
    let sawTool = false, sawStream = false, sawInterject = false
    let sawDone = false, sawError = false
    let sawDoneGreen = false, sawErrorRed = false
    let firstToolT = null, firstStreamT = null, firstInterjectT = null
    let maxX = bootCursor.x, maxY = bootCursor.y
    let maxFakeToolOnScreen = 0, maxXOnScreen = 0, cursorMoved = false

    // Poll for up to the lifecycle + a 60s grace period.
    const lifecycleMs = Number(process.env.FAKE_LIFECYCLE_MS ?? 30 * 60 * 1000)
    const pollMs = lifecycleMs + 60000
    const stepMs = 2000
    let elapsed = 0
    for (let t = 2; (elapsed = Date.now() - sendT) < pollMs; t += 1) {
      await sleep(stepMs)
      const raw = kitten(['get-text', '-m', match])
      const pane = stripAnsi(raw)
      // Color-checked read: does a done line carry GREEN, an error line carry RED?
      if (raw.includes('done') && raw.includes(GREEN)) sawDoneGreen = true
      if (raw.includes('error') && raw.includes(RED)) sawErrorRed = true

      const cur = parseCursor(kitten(['get-text', '-m', match, '--add-cursor'])) || { x: maxX, y: maxY }
      maxX = Math.max(maxX, cur.x); maxY = Math.max(maxY, cur.y)
      if (cur.x !== bootCursor.x || cur.y !== bootCursor.y) cursorMoved = true

      const toolCount = (pane.match(/fake_tool/g) || []).length
      const xCount = (pane.match(/\bx\b/g) || []).length
      maxFakeToolOnScreen = Math.max(maxFakeToolOnScreen, toolCount)
      maxXOnScreen = Math.max(maxXOnScreen, xCount)

      const e = (Date.now() - sendT) / 1000
      if (toolCount > 0 && !sawTool) { sawTool = true; firstToolT = e }
      if (xCount > 50 && !sawStream) { sawStream = true; firstStreamT = e }
      if (pane.includes('user interjection') && !sawInterject) { sawInterject = true; firstInterjectT = e }
      if (pane.includes('✓ done')) sawDone = true
      if (pane.includes('✗ error')) sawError = true

      if (t % 5 === 0) {
        console.log(`INFO: t=${e.toFixed(0)}s cursor=(${cur.x},${cur.y}) toolBlocksOnScreen=${toolCount} xCharsOnScreen=${xCount} done=${sawDone} error=${sawError} green=${sawDoneGreen} red=${sawErrorRed}`)
      }
    }
    // No early-out: the sample loop runs the full lifecycle so the TUI is
    // exercised end-to-end for the entire 30 minute window, as required.

    // --- Assertions ------------------------------------------------------
    if (!sawTool) fail('no tool calls rendered (expected 500 fake_tool calls)')
    else pass(`tool calls rendered (first at t=${firstToolT?.toFixed(1)}s, max ${maxFakeToolOnScreen} visible at once)`)
    if (!sawStream) fail('no streamed assistant text rendered (expected ~30000 chars)')
    else pass(`streamed text rendered (first at t=${firstStreamT?.toFixed(1)}s, max xCount=${maxXOnScreen})`)
    if (firstToolT !== null && firstToolT < 9) fail(`think delay too short (tools at t=${firstToolT.toFixed(1)}s)`)
    if (firstStreamT !== null && firstToolT !== null && firstStreamT <= firstToolT) fail('streaming did not follow tool calls')
    if (!sawInterject) fail('no user interjection (You:) rendered mid-stream')
    else pass(`user interjection rendered (first at t=${firstInterjectT?.toFixed(1)}s)`)
    if (!sawDone) fail('no done tool state (✓ done) observed')
    else pass('done tool state (✓ done) observed')
    if (!sawError) fail('no error tool state (✗ error) observed')
    else pass('error tool state (✗ error) observed')
    if (!sawDoneGreen) fail('done state not rendered in GREEN (\\x1b[32m)')
    else pass('done state rendered in GREEN')
    if (!sawErrorRed) fail('error state not rendered in RED (\\x1b[31m)')
    else pass('error state rendered in RED')
    if (!cursorMoved) fail('cursor never moved (rendering / cursor read broken)')
    else pass(`cursor moved during the run (reached (${maxX}, ${maxY}))`)

    cleanup()
    if (failures > 0) { console.error(`\nfake-kitty: ${failures} assertion(s) failed`); process.exit(1) }
    console.log('\nfake-kitty: Kitty remote-control stress assertions passed (boot / think / 500 tools / 30k stream / interject / color / cursor)')
  } catch (e) {
    console.error(`fake-kitty: unexpected error: ${e.message}`)
    cleanup()
    process.exit(1)
  }
}

main()
