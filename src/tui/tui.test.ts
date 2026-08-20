// Tests for src/tui/tui.ts — differential rendering, frame throttling,
// fullscreen enter/exit, and the boot screen, driven through a fake terminal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Transcript } from './boot/transcript.js'
import { createBootScreen } from './boot/screen.js'
import { Text } from './components/text.js'
import { FakeTerminal } from './fake-terminal.js'
import { TUI } from './tui.js'
import { stripAnsi } from './utils.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Let a pending requestRender flow through: requestRender schedules
 * scheduleRender via nextTick, which then arms the throttled render timer.
 */
async function flushRender(): Promise<void> {
  await new Promise((resolve) => process.nextTick(resolve))
  await vi.advanceTimersByTimeAsync(16)
}

async function startBoot(): Promise<{ term: FakeTerminal; boot: ReturnType<typeof createBootScreen> }> {
  const term = new FakeTerminal(80, 24)
  const boot = createBootScreen(term, { model: 'glm-5.2', cwd: '/tmp/proj' })
  boot.tui.start()
  await flushRender()
  return { term, boot }
}

describe('fullscreen enter/exit', () => {
  it('enters the alt screen on boot and paints the layout', async () => {
    const { term, boot } = await startBoot()
    expect(term.altScreenActive).toBe(true)
    expect(term.mouseTrackingActive).toBe(true)
    expect(term.output).toContain('\x1b[?1049h')
    expect(boot.tui.isFullscreen()).toBe(true)
  })

  it('leaves the primary screen untouched when exiting', async () => {
    const { term, boot } = await startBoot()
    const before = term.output.length
    boot.tui.exitFullscreen()
    expect(term.altScreenActive).toBe(false)
    expect(term.mouseTrackingActive).toBe(false)
    expect(term.output).toContain('\x1b[?1049l')
    // Exit only appends the leave sequence and a flush render — it never
    // rewrites the primary screen content.
    expect(term.output.slice(before)).toContain('\x1b[?1049l')
  })

  it('restores cursor visibility and raw state on stop', async () => {
    const { term, boot } = await startBoot()
    boot.tui.stop()
    expect(term.stoppedState).toBe(true)
    expect(term.output).toContain('\x1b[?25h') // show cursor
    expect(term.output).toContain('\x1b[?1049l')
  })
})

describe('boot screen', () => {
  it('renders header, input dock, and footer', async () => {
    const { term } = await startBoot()
    expect(term.output).toContain('min-agent')
    expect(term.output).toContain('glm-5.2')
    expect(term.output).toContain('/tmp/proj')
    expect(term.output).toContain('type to start')
    expect(term.output).toContain('> ')
  })

  it('appends a role-labeled transcript row when typing and submitting', async () => {
    const { term, boot } = await startBoot()
    boot.input.onSubmit = (value) => {
      boot.transcript.addUser(value)
    }

    term.emitInput('h')
    term.emitInput('e')
    term.emitInput('l')
    term.emitInput('l')
    term.emitInput('o')
    await flushRender()
    expect(boot.input.getValue()).toBe('hello')

    const before = term.output.length
    term.emitInput('\r')
    await flushRender()
    expect(boot.transcript.getBlocks()).toEqual([{ kind: 'user', text: 'hello' }])
    expect(stripAnsi(term.output.slice(before))).toContain('You: hello')
  })

  it('renders the input cursor marker at the IME position', async () => {
    const { term, boot } = await startBoot()
    term.emitInput('a')
    await flushRender()
    // The focused input emits the zero-width cursor marker; the TUI strips it
    // and positions the hardware cursor (absolute addressing in the paint).
    expect(term.output).toContain('\x1b[2J') // initial full clear
    expect(boot.input.getValue()).toBe('a')
  })

  it('consumes mouse reports without forwarding them to the input', async () => {
    const { term, boot } = await startBoot()
    term.emitInput('\x1b[<35;20;5m')
    await flushRender()
    expect(boot.input.getValue()).toBe('')
  })
})

describe('differential rendering', () => {
  it('repaints only changed lines inside synchronized output (inline)', async () => {
    const term = new FakeTerminal(80, 24)
    const tui = new TUI(term)
    const text = new Text('line one', 0, 0)
    tui.addChild(text)
    tui.start()
    await flushRender()
    expect(term.output).toContain('line one')

    const baseline = term.output.length
    text.setText('line two')
    tui.requestRender()
    await flushRender()

    const delta = term.output.slice(baseline)
    expect(delta).toContain('\x1b[?2026h') // synchronized output start
    expect(delta).toContain('\x1b[?2026l') // synchronized output end
    expect(delta).toContain('line two')
    expect(delta).not.toContain('line one')
  })

  it('repaints only changed rows inside synchronized output (fullscreen)', async () => {
    const term = new FakeTerminal(80, 24)
    const tui = new TUI(term)
    const text = new Text('aaa', 0, 0)
    const dock = new Text('> ', 0, 0)
    tui.enterFullscreen({ scroll: [text], dock })
    tui.start()
    await flushRender()

    const baseline = term.output.length
    text.setText('bbb')
    tui.requestRender()
    await flushRender()

    const delta = term.output.slice(baseline)
    expect(delta).toContain('\x1b[?2026h')
    expect(delta).toContain('\x1b[?2026l')
    expect(delta).toContain('bbb')
    expect(delta).not.toContain('aaa')
  })

  it('emits no content redraw when nothing changed', async () => {
    const term = new FakeTerminal(80, 24)
    const tui = new TUI(term)
    tui.addChild(new Text('stable', 0, 0))
    tui.start()
    await flushRender()

    const baseline = term.output.length
    tui.requestRender()
    await flushRender()
    const delta = term.output.slice(baseline)
    // No synchronized-output sequence and no line repaint; the only byte
    // emitted is the cursor-visibility control.
    expect(delta).not.toContain('\x1b[?2026h')
    expect(delta).not.toContain('stable')
  })
})

describe('frame throttling', () => {
  it('coalesces repaints at a 16ms minimum interval', async () => {
    const term = new FakeTerminal(80, 24)
    const tui = new TUI(term)
    const text = new Text('a', 0, 0)
    tui.addChild(text)
    tui.start()
    await flushRender()
    const baseline = term.output.length

    text.setText('b')
    tui.requestRender()
    text.setText('c')
    tui.requestRender()
    text.setText('d')
    tui.requestRender()

    // scheduleRender is armed via nextTick; run it so the timer is set
    await new Promise((resolve) => process.nextTick(resolve))

    await vi.advanceTimersByTimeAsync(8)
    expect(term.output.length).toBe(baseline) // below 16ms: no repaint yet

    await vi.advanceTimersByTimeAsync(8)
    expect(term.output.length).toBeGreaterThan(baseline)
    // The coalesced render paints only the final state
    expect(term.output.slice(baseline)).toContain('d')
    expect(term.output.slice(baseline)).not.toContain('b')
  })
})

describe('resize handling', () => {
  it('re-renders on resize events', async () => {
    const { term, boot } = await startBoot()
    const baseline = term.output.length
    term.setSize(100, 30)
    term.emitResize()
    await flushRender()
    expect(term.output.length).toBeGreaterThan(baseline)
    expect(boot.tui.isFullscreen()).toBe(true)
  })
})

describe('mouse interaction', () => {
  /** Fullscreen with a single wrapped transcript block and a one-line dock. */
  async function startTranscript(text: string): Promise<{ term: FakeTerminal; tui: TUI }> {
    const term = new FakeTerminal(80, 24)
    const transcript = new Transcript()
    transcript.addUser(text)
    const tui = new TUI(term)
    tui.enterFullscreen({ scroll: [transcript], dock: new Text('> ', 0, 0) })
    tui.start()
    await flushRender()
    return { term, tui }
  }

  it('scrolls the transcript with the mouse wheel', async () => {
    // 2000 chars wrap to 28 rows in a 23-row window (You: label uses 5 cols): maxScroll = 5
    const { term, tui } = await startTranscript('x'.repeat(2000))
    expect(tui.getScrollInfo()?.linesAbove).toBe(5)
    expect(tui.getScrollInfo()?.following).toBe(true)

    term.emitInput('\x1b[<64;20;10M') // wheel up
    await flushRender()
    expect(tui.getScrollInfo()?.linesAbove).toBe(2)

    term.emitInput('\x1b[<64;20;10M') // wheel up again (clamped at top)
    await flushRender()
    expect(tui.getScrollInfo()?.linesAbove).toBe(0)
    expect(tui.getScrollInfo()?.following).toBe(false)

    term.emitInput('\x1b[<65;20;10M') // wheel down
    await flushRender()
    term.emitInput('\x1b[<65;20;10M') // wheel down back to bottom
    await flushRender()
    expect(tui.getScrollInfo()?.linesAbove).toBe(5)
    expect(tui.getScrollInfo()?.following).toBe(true)
  })

  it('selects by drag and copies the selection via OSC 52', async () => {
    const { term, tui } = await startTranscript('hello world')
    // The row renders as "You: hello world"; "hello" spans cols 5..9.
    term.emitInput('\x1b[<0;6;1M') // press at (6,1) -> col 5
    await flushRender()
    term.emitInput('\x1b[<32;10;1M') // drag to (10,1) -> col 9
    await flushRender()
    expect(term.output).toContain('\x1b[7m') // inverse-video highlight rendered

    const before = term.output.length
    term.emitInput('\x1b[<0;10;1m') // release at (10,1)
    await flushRender()
    expect(term.clipboard).toBe('hello')
    // Selection is cleared after release; the repaint carries no highlight
    expect(term.output.slice(before)).not.toContain('\x1b[7m')
  })

  it('opens a hyperlink on click', async () => {
    const line = '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'
    const { term, tui } = await startTranscript(`see ${line} here`)
    // Layout: "You: " (5 cols, 0..4), then "see " (5..8), then "link" (9..12).
    term.emitInput('\x1b[<0;10;1M') // press on col 9 — inside "link"
    await flushRender()
    term.emitInput('\x1b[<0;10;1m') // release — a click
    await flushRender()
    expect(term.lastOpenedLink).toBe('https://example.com')
  })

  it('does not open a link when clicking plain text', async () => {
    const { term, tui } = await startTranscript('no links here')
    term.emitInput('\x1b[<0;30;1M')
    await flushRender()
    term.emitInput('\x1b[<0;30;1m')
    await flushRender()
    expect(term.lastOpenedLink).toBeNull()
    expect(term.clipboard).toBe('')
  })

  it('ignores clicks on the dock (below the transcript window)', async () => {
    const { term, tui } = await startTranscript('hello world')
    term.emitInput('\x1b[<0;5;24M') // press on the last screen row (dock)
    await flushRender()
    term.emitInput('\x1b[<0;5;24m')
    await flushRender()
    expect(term.clipboard).toBe('')
    expect(term.lastOpenedLink).toBeNull()
    // Mouse reports never reach the focused input component
    expect(stripAnsi(term.output)).toContain('hello world')
  })
})

describe('tool block expansion', () => {
  it('toggles every tool block via ctrl+o', async () => {
    const { term, boot } = await startBoot()
    boot.transcript.addTool('read_file', { path: '/x' })
    boot.transcript.setToolResult('contents')
    boot.tui.requestRender()
    await flushRender()
    expect(boot.transcript.getToolsExpanded()).toBe(false)
    expect(stripAnsi(term.output)).toContain('read_file')
    expect(stripAnsi(term.output)).toContain('(ctrl+o to expand)')

    term.emitInput('\x0f') // ctrl+o
    await flushRender()
    expect(boot.transcript.getToolsExpanded()).toBe(true)
    expect(stripAnsi(term.output)).toContain('result: contents')
    const before = term.output.length

    term.emitInput('\x0f') // ctrl+o — collapse again
    await flushRender()
    expect(boot.transcript.getToolsExpanded()).toBe(false)
    // The repaint no longer writes the result body
    expect(stripAnsi(term.output.slice(before))).not.toContain('result: contents')
  })

  it('expands a single tool block on header click', async () => {
    const { term, boot } = await startBoot()
    boot.transcript.addTool('read_file', { path: '/x' })
    boot.transcript.setToolResult('contents')
    boot.tui.requestRender()
    await flushRender()
    // Header renders 4 rows at 80 cols, so the tool header sits on screen row 4 (1-based y = 5).
    term.emitInput('\x1b[<0;5;5M') // press on the tool header
    await flushRender()
    term.emitInput('\x1b[<0;5;5m') // release -> click
    await flushRender()
    expect(boot.transcript.getBlocks()[0]).toMatchObject({ expanded: true })
    expect(stripAnsi(term.output)).toContain('result: contents')
    // Click again collapses it
    term.emitInput('\x1b[<0;5;5M')
    await flushRender()
    term.emitInput('\x1b[<0;5;5m')
    await flushRender()
    expect(boot.transcript.getBlocks()[0]).toMatchObject({ expanded: false })
  })

  it('keeps the scroll position while expanding and collapsing', async () => {
    const { boot } = await startBoot()
    // 30 collapsed tool blocks overflow the 23-row transcript window
    for (let i = 0; i < 30; i++) {
      boot.transcript.addTool(`t${i}`)
      boot.transcript.setToolResult(`r${i}`)
    }
    boot.tui.requestRender()
    await flushRender()
    // Scroll up a few lines from the bottom and pause following
    boot.tui.scrollBy(-3)
    await flushRender()
    expect(boot.tui.getScrollInfo()?.following).toBe(false)
    const anchor = boot.tui.getScrollInfo()?.linesAbove

    // Expanding lengthens the transcript; the anchor must not jump
    boot.transcript.setToolsExpanded(true)
    boot.tui.requestRender()
    await flushRender()
    expect(boot.tui.getScrollInfo()?.linesAbove).toBe(anchor)
    expect(boot.tui.getScrollInfo()?.following).toBe(false)

    // Collapsing shortens it again; the anchor still holds
    boot.transcript.setToolsExpanded(false)
    boot.tui.requestRender()
    await flushRender()
    expect(boot.tui.getScrollInfo()?.linesAbove).toBe(anchor)
    expect(boot.tui.getScrollInfo()?.following).toBe(false)
  })
})
