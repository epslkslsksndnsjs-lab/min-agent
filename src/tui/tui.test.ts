// Tests for src/tui/tui.ts — differential rendering, frame throttling,
// fullscreen enter/exit, and the boot screen, driven through a fake terminal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBootScreen } from './boot/screen.js'
import { Text } from './components/text.js'
import { FakeTerminal } from './fake-terminal.js'
import { TUI } from './tui.js'

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

  it('appends a transcript row when typing and submitting', async () => {
    const { term, boot } = await startBoot()
    boot.input.onSubmit = (value) => {
      boot.transcript.appendLine(`You: ${value}`)
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
    expect(boot.transcript.getLines()).toEqual(['You: hello'])
    expect(term.output.slice(before)).toContain('You: hello')
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
