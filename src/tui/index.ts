// TUI subsystem public API.

// Boot screen composition
export { createBootScreen, type BootScreen, type BootScreenOptions } from './boot/screen.js'
export { Footer } from './boot/footer.js'
export { Header, formatSplashCwd, type HeaderMetadataLine, type HeaderOptions } from './boot/header.js'
export { InputDock } from './boot/dock.js'
export { Transcript, type TranscriptBlock } from './boot/transcript.js'
export { styleText, type TextStyle } from './boot/theme.js'
// Agent event pipeline
export { AgentEventAdapter, hydrateTranscript } from './event-adapter.js'
// Components
export { Box } from './components/box.js'
export { Input } from './components/input.js'
export { Spacer } from './components/spacer.js'
export { Text } from './components/text.js'
export { TruncatedText } from './components/truncated-text.js'
// Fullscreen (alternate-screen) viewport
export { clippedFullscreenDockHeight, FULLSCREEN_MIN_TRANSCRIPT_ROWS, FullscreenViewport, type ScrollInfo } from './fullscreen.js'
// Keybindings
export {
  getKeybindings,
  type Keybinding,
  type KeybindingConflict,
  type KeybindingDefinition,
  type KeybindingDefinitions,
  type Keybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from './keybindings.js'
// Keyboard input handling
export {
  decodeKittyPrintable,
  decodePrintableKey,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  type KeyEventType,
  type KeyId,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from './keys.js'
// Kill ring / undo support
export { KillRing } from './kill-ring.js'
// SGR mouse event parsing
export {
  isMouseSequence,
  isWheelDown,
  isWheelUp,
  MOUSE_WHEEL_DOWN,
  MOUSE_WHEEL_UP,
  MOUSE_BUTTON_LEFT,
  type MouseEvent,
  parseSgrMouseEvent,
} from './mouse.js'
// Render caching
export { VersionedRenderCache } from './render-cache.js'
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from './stdin-buffer.js'
// Terminal interface and implementation
export { ProcessTerminal, type Terminal } from './terminal.js'
// Core TUI interfaces and classes
export {
  type Component,
  Container,
  CURSOR_MARKER,
  type Focusable,
  type FullscreenOptions,
  isFocusable,
  TUI,
  type TuiStopOptions,
} from './tui.js'
// Undo stack
export { UndoStack } from './undo-stack.js'
// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from './utils.js'
