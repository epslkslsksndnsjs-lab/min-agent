// Terminal text utilities: visible-width measurement, ANSI stripping,
// column slicing, truncation, and word wrapping.

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Get the shared grapheme segmenter instance. */
export function getSegmenter(): Intl.Segmenter {
  return segmenter
}

// Regexes for character classification
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/u
const emojiPresentationRegex = /^\p{Emoji_Presentation}$/u

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * Fast heuristic to avoid the expensive RGI_Emoji regex test on every cluster.
 */
function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0)!
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and pictographs
    (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
    (cp >= 0x2b50 && cp <= 0x2b55) || // Stars/circles
    segment.includes('\uFE0F') || // Emoji presentation selector
    segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
  )
}

/**
 * East Asian Width W/F ranges (wide or fullwidth in terminal cells).
 * Covers CJK ideographs, kana, hangul, fullwidth forms, and compat ranges.
 */
function isWideCodepoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi syllables
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B+
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512
const widthCache = new Map<string, number>()

function isPrintableAscii(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      return false
    }
  }
  return true
}

/**
 * Check if a grapheme cluster renders as a wide emoji. Multi-codepoint
 * sequences (ZWJ, skin tones, VS16) and Emoji_Presentation codepoints are
 * treated as two cells; a cheap pre-filter avoids the regex for most text.
 */
function isEmojiWide(segment: string): boolean {
  if (!couldBeEmoji(segment)) return false
  if (segment.length > 2) return true // ZWJ / skin-tone / VS16 sequences
  if (segment.includes('\uFE0F')) return true // VS16 forces emoji presentation
  return emojiPresentationRegex.test(segment)
}

/** Terminal cell width of a single grapheme cluster. */
function graphemeWidth(segment: string): number {
  // Zero-width clusters
  if (zeroWidthRegex.test(segment)) {
    return 0
  }

  // Emoji render as two cells in terminals
  if (isEmojiWide(segment)) {
    return 2
  }

  // Base visible codepoint
  const base = segment.replace(leadingNonPrintingRegex, '')
  const cp = base.codePointAt(0)
  if (cp === undefined) {
    return 0
  }

  // Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
  // full-width emoji even when isolated during streaming. Keep width
  // conservative (2) to avoid terminal auto-wrap drift artifacts.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    return 2
  }

  let width = isWideCodepoint(cp) ? 2 : 1

  // Trailing halfwidth/fullwidth forms and AM vowels that segment with a base
  if (segment.length > 1) {
    for (const char of segment.slice(1)) {
      const c = char.codePointAt(0)!
      if (c >= 0xff00 && c <= 0xffef) {
        width += isWideCodepoint(c) ? 2 : 1
      } else if (c === 0x0e33 || c === 0x0eb3) {
        width += 1
      }
    }
  }

  return width
}

/** Calculate the visible width of a string in terminal columns. */
export function visibleWidth(str: string): number {
  if (str.length === 0) {
    return 0
  }

  // Fast path: pure ASCII printable
  if (isPrintableAscii(str)) {
    return str.length
  }

  // Check cache
  const cached = widthCache.get(str)
  if (cached !== undefined) {
    return cached
  }

  // Normalize: tabs to 3 spaces, strip ANSI escape sequences
  let clean = str
  if (str.includes('\t')) {
    clean = clean.replace(/\t/g, '   ')
  }
  if (clean.includes('\x1b')) {
    let stripped = ''
    let i = 0
    const extractAnsi = createAnsiCodeExtractor(clean)
    while (i < clean.length) {
      const ansi = extractAnsi(i)
      if (ansi) {
        i += ansi.length
        continue
      }
      stripped += clean[i]
      i++
    }
    clean = stripped
  }

  // Calculate width
  let width = 0
  for (const { segment } of segmenter.segment(clean)) {
    width += graphemeWidth(segment)
  }

  // Cache result
  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value
    if (firstKey !== undefined) {
      widthCache.delete(firstKey)
    }
  }
  widthCache.set(str, width)

  return width
}

/** Find the terminal-column span containing visible, non-whitespace content. */
export function visibleContentSpan(line: string, maxWidth: number): { from: number; to: number } | null {
  const limit = Math.floor(maxWidth)
  if (line.length === 0 || !Number.isFinite(limit) || limit <= 0) {
    return null
  }

  let from = -1
  let to = -1
  let currentCol = 0
  let i = 0
  const extractAnsi = createAnsiCodeExtractor(line)

  while (i < line.length && currentCol < limit) {
    const ansi = extractAnsi(i)
    if (ansi) {
      i += ansi.length
      continue
    }

    if (line[i] === '\t') {
      currentCol += 3
      i++
      continue
    }

    let textEnd = i
    while (textEnd < line.length && line[textEnd] !== '\t' && !extractAnsi(textEnd)) {
      textEnd++
    }

    for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
      const width = graphemeWidth(segment)
      const segmentStart = currentCol
      const segmentEnd = currentCol + width
      if (width > 0 && segment.trim().length > 0 && segmentStart < limit) {
        if (from === -1) from = segmentStart
        to = Math.min(segmentEnd, limit)
      }
      currentCol = segmentEnd
      if (currentCol >= limit) break
    }
    i = textEnd
  }

  return from === -1 ? null : { from, to }
}

/**
 * Normalize text for terminal output without changing logical content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint; their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g
const TAB_REGEX = /\t/
const TAB_GLOBAL_REGEX = /\t/g

export function normalizeTerminalOutput(str: string): string {
  const hasThaiLaoAm = THAI_LAO_AM_REGEX.test(str)
  const hasTab = TAB_REGEX.test(str)
  if (!hasThaiLaoAm && !hasTab) return str

  let normalized = str
  if (hasThaiLaoAm) {
    normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
      char === '\u0e33' ? '\u0e4d\u0e32' : '\u0ecd\u0eb2',
    )
  }
  if (hasTab) {
    normalized = normalized.replace(TAB_GLOBAL_REGEX, '   ')
  }
  return normalized
}

interface AnsiCode {
  code: string
  length: number
}

type ControlStringEnds = Map<number, number | null>

interface AnsiScanState {
  controlStringEnds?: ControlStringEnds
}

function cacheControlStringEnds(str: string, from: number, ends: ControlStringEnds): void {
  let nextBel = -1
  let nextSt = -1

  for (let i = str.length - 1; i >= from; i--) {
    if (str[i] === '\x07') {
      nextBel = i
    }
    if (str[i] !== '\x1b') {
      continue
    }

    const next = str[i + 1]
    if (next === '\\') {
      nextSt = i
    } else if (next === ']' || next === '_') {
      if (nextBel !== -1 && (nextSt === -1 || nextBel < nextSt)) {
        ends.set(i, nextBel + 1)
      } else {
        ends.set(i, nextSt === -1 ? null : nextSt + 2)
      }
    } else if (next === 'P' || next === '^' || next === 'X') {
      ends.set(i, nextSt === -1 ? null : nextSt + 2)
    }
  }
}

function extractControlStringEnd(str: string, pos: number, allowBel: boolean, state?: AnsiScanState): number | null {
  if (state?.controlStringEnds?.has(pos)) {
    const end = state.controlStringEnds.get(pos)
    return end ?? null
  }

  let j = pos + 2
  while (j < str.length) {
    if (allowBel && str[j] === '\x07') {
      return j + 1
    }
    if (str[j] === '\x1b' && str[j + 1] === '\\') {
      return j + 2
    }
    j++
  }
  if (state) {
    const ends: ControlStringEnds = new Map()
    cacheControlStringEnds(str, pos, ends)
    state.controlStringEnds = ends
  }
  return null
}

function extractAnsiEndAt(str: string, pos: number, state?: AnsiScanState): number | null {
  if (pos >= str.length || str[pos] !== '\x1b') return null

  const next = str[pos + 1]

  // CSI: parameter bytes, then intermediate bytes, then one final byte
  if (next === '[') {
    let j = pos + 2
    let hasIntermediate = false
    while (j < str.length) {
      const byte = str.charCodeAt(j)
      if (byte >= 0x30 && byte <= 0x3f && !hasIntermediate) {
        j++
        continue
      }
      if (byte >= 0x20 && byte <= 0x2f) {
        hasIntermediate = true
        j++
        continue
      }
      if (byte >= 0x40 && byte <= 0x7e) {
        return j + 1
      }
      return null
    }
    return null
  }

  // OSC uses BEL or ST. APC also accepts BEL for existing private markers.
  if (next === ']' || next === '_') {
    return extractControlStringEnd(str, pos, true, state)
  }

  // DCS, PM, and SOS are terminated by ST
  if (next === 'P' || next === '^' || next === 'X') {
    return extractControlStringEnd(str, pos, false, state)
  }

  return null
}

function extractAnsiCodeAt(str: string, pos: number, state?: AnsiScanState): AnsiCode | null {
  const end = extractAnsiEndAt(str, pos, state)
  return end === null ? null : { code: str.substring(pos, end), length: end - pos }
}

/** Create a scanner whose malformed-control-string cache is released after this string scan. */
export function createAnsiCodeExtractor(str: string): (pos: number) => AnsiCode | null {
  const state: AnsiScanState = {}
  return (pos) => extractAnsiCodeAt(str, pos, state)
}

function createAnsiEndExtractor(str: string): (pos: number) => number | null {
  const state: AnsiScanState = {}
  return (pos) => extractAnsiEndAt(str, pos, state)
}

// Fast path for the common CSI form; the shared scanner handles the wider
// CSI grammar, control strings, malformed sequences, and two-byte escapes.
const COMMON_CSI_REGEX = /\x1b\[[0-9;:?<=>]*[\x40-\x7e]/g

/** Remove all escape sequences (CSI, OSC, DCS/APC, two-char) leaving plain text. */
export function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) return str

  const input = str.replace(COMMON_CSI_REGEX, '')
  let escapeIndex = input.indexOf('\x1b')
  if (escapeIndex === -1) return input

  const result: string[] = []
  let plainStart = 0
  const extractAnsiEnd = createAnsiEndExtractor(input)
  while (escapeIndex !== -1) {
    const ansiEnd = extractAnsiEnd(escapeIndex)
    if (ansiEnd !== null) {
      if (plainStart < escapeIndex) result.push(input.slice(plainStart, escapeIndex))
      plainStart = ansiEnd
    } else {
      const next = input.charCodeAt(escapeIndex + 1)
      if (escapeIndex + 1 < input.length && next !== 0x0a && next !== 0x0d && next !== 0x2028 && next !== 0x2029) {
        if (plainStart < escapeIndex) result.push(input.slice(plainStart, escapeIndex))
        plainStart = escapeIndex + 2
      }
    }
    escapeIndex = input.indexOf('\x1b', Math.max(escapeIndex + 1, plainStart))
  }
  if (plainStart < input.length) result.push(input.slice(plainStart))
  return result.join('')
}

/** Check if a character is whitespace. */
export function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char)
}

const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/

/** Check if a character is punctuation. */
export function isPunctuationChar(char: string): boolean {
  return PUNCTUATION_REGEX.test(char)
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
  private bold = false
  private dim = false
  private italic = false
  private underline = false
  private blink = false
  private inverse = false
  private hidden = false
  private strikethrough = false
  private fgColor: string | null = null
  private bgColor: string | null = null

  process(ansiCode: string): void {
    if (!ansiCode.endsWith('m')) {
      return
    }

    const match = ansiCode.match(/\x1b\[([\d;]*)m/)
    if (!match) return

    const params = match[1]
    if (params === '' || params === '0') {
      this.reset()
      return
    }

    const parts = params.split(';')
    let i = 0
    while (i < parts.length) {
      const code = Number.parseInt(parts[i], 10)

      // Handle 256-color and RGB codes which consume multiple parameters
      if (code === 38 || code === 48) {
        if (parts[i + 1] === '5' && parts[i + 2] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`
          if (code === 38) {
            this.fgColor = colorCode
          } else {
            this.bgColor = colorCode
          }
          i += 3
          continue
        } else if (parts[i + 1] === '2' && parts[i + 4] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`
          if (code === 38) {
            this.fgColor = colorCode
          } else {
            this.bgColor = colorCode
          }
          i += 5
          continue
        }
      }

      switch (code) {
        case 0:
          this.reset()
          break
        case 1:
          this.bold = true
          break
        case 2:
          this.dim = true
          break
        case 3:
          this.italic = true
          break
        case 4:
          this.underline = true
          break
        case 5:
          this.blink = true
          break
        case 7:
          this.inverse = true
          break
        case 8:
          this.hidden = true
          break
        case 9:
          this.strikethrough = true
          break
        case 21:
          this.bold = false
          break
        case 22:
          this.bold = false
          this.dim = false
          break
        case 23:
          this.italic = false
          break
        case 24:
          this.underline = false
          break
        case 25:
          this.blink = false
          break
        case 27:
          this.inverse = false
          break
        case 28:
          this.hidden = false
          break
        case 29:
          this.strikethrough = false
          break
        case 39:
          this.fgColor = null
          break
        case 49:
          this.bgColor = null
          break
        default:
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            this.fgColor = String(code)
          } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
            this.bgColor = String(code)
          }
          break
      }
      i++
    }
  }

  private reset(): void {
    this.bold = false
    this.dim = false
    this.italic = false
    this.underline = false
    this.blink = false
    this.inverse = false
    this.hidden = false
    this.strikethrough = false
    this.fgColor = null
    this.bgColor = null
  }

  /** Clear all state for reuse. */
  clear(): void {
    this.reset()
  }

  getActiveCodes(): string {
    const codes: string[] = []
    if (this.bold) codes.push('1')
    if (this.dim) codes.push('2')
    if (this.italic) codes.push('3')
    if (this.underline) codes.push('4')
    if (this.blink) codes.push('5')
    if (this.inverse) codes.push('7')
    if (this.hidden) codes.push('8')
    if (this.strikethrough) codes.push('9')
    if (this.fgColor) codes.push(this.fgColor)
    if (this.bgColor) codes.push(this.bgColor)
    return codes.length > 0 ? `\x1b[${codes.join(';')}m` : ''
  }

  /**
   * Get reset codes for attributes that need to be turned off at line end.
   * Underline must be closed to prevent bleeding into padding.
   */
  getLineEndReset(): string {
    return this.underline ? '\x1b[24m' : ''
  }
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
  let i = 0
  const extractAnsi = createAnsiCodeExtractor(text)
  while (i < text.length) {
    const ansiResult = extractAnsi(i)
    if (ansiResult) {
      tracker.process(ansiResult.code)
      i += ansiResult.length
    } else {
      i++
    }
  }
}

/** Split text into words while keeping ANSI codes attached. */
function splitIntoTokensWithAnsi(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let pendingAnsi = ''
  let inWhitespace = false
  let i = 0
  const extractAnsi = createAnsiCodeExtractor(text)

  while (i < text.length) {
    const ansiResult = extractAnsi(i)
    if (ansiResult) {
      pendingAnsi += ansiResult.code
      i += ansiResult.length
      continue
    }

    const char = text[i]
    const charIsSpace = char === ' '

    if (charIsSpace !== inWhitespace && current) {
      tokens.push(current)
      current = ''
    }

    if (pendingAnsi) {
      current += pendingAnsi
      pendingAnsi = ''
    }

    inWhitespace = charIsSpace
    current += char
    i++
  }

  if (pendingAnsi) {
    current += pendingAnsi
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

/**
 * Wrap text with ANSI codes preserved. Only does word wrapping — no padding,
 * no background colors. Active ANSI codes are preserved across line breaks.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (!text) {
    return ['']
  }

  const inputLines = text.split('\n')
  const result: string[] = []
  const tracker = new AnsiCodeTracker()

  for (const inputLine of inputLines) {
    const prefix = result.length > 0 ? tracker.getActiveCodes() : ''
    result.push(...wrapSingleLine(prefix + inputLine, width))
    updateTrackerFromText(inputLine, tracker)
  }

  return result.length > 0 ? result : ['']
}

function wrapSingleLine(line: string, width: number): string[] {
  if (!line) {
    return ['']
  }

  const visibleLength = visibleWidth(line)
  if (visibleLength <= width) {
    return [line]
  }

  const wrapped: string[] = []
  const tracker = new AnsiCodeTracker()
  const tokens = splitIntoTokensWithAnsi(line)

  let currentLine = ''
  let currentVisibleLength = 0

  for (const token of tokens) {
    const tokenVisibleLength = visibleWidth(token)
    const isWhitespace = token.trim() === ''

    if (tokenVisibleLength > width && !isWhitespace) {
      if (currentLine) {
        const lineEndReset = tracker.getLineEndReset()
        if (lineEndReset) {
          currentLine += lineEndReset
        }
        wrapped.push(currentLine)
        currentLine = ''
        currentVisibleLength = 0
      }

      const broken = breakLongWord(token, width, tracker)
      wrapped.push(...broken.slice(0, -1))
      currentLine = broken[broken.length - 1]
      currentVisibleLength = visibleWidth(currentLine)
      continue
    }

    const totalNeeded = currentVisibleLength + tokenVisibleLength

    if (totalNeeded > width && currentVisibleLength > 0) {
      let lineToWrap = currentLine.trimEnd()
      const lineEndReset = tracker.getLineEndReset()
      if (lineEndReset) {
        lineToWrap += lineEndReset
      }
      wrapped.push(lineToWrap)
      if (isWhitespace) {
        currentLine = tracker.getActiveCodes()
        currentVisibleLength = 0
      } else {
        currentLine = tracker.getActiveCodes() + token
        currentVisibleLength = tokenVisibleLength
      }
    } else {
      currentLine += token
      currentVisibleLength += tokenVisibleLength
    }

    updateTrackerFromText(token, tracker)
  }

  if (currentLine) {
    wrapped.push(currentLine)
  }

  return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : ['']
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
  const lines: string[] = []
  let currentLine = tracker.getActiveCodes()
  let currentWidth = 0

  let i = 0
  const segments: Array<{ type: 'ansi' | 'grapheme'; value: string }> = []
  const extractAnsi = createAnsiCodeExtractor(word)

  while (i < word.length) {
    const ansiResult = extractAnsi(i)
    if (ansiResult) {
      segments.push({ type: 'ansi', value: ansiResult.code })
      i += ansiResult.length
    } else {
      let end = i
      while (end < word.length) {
        const nextAnsi = extractAnsi(end)
        if (nextAnsi) break
        end++
      }
      const textPortion = word.slice(i, end)
      for (const seg of segmenter.segment(textPortion)) {
        segments.push({ type: 'grapheme', value: seg.segment })
      }
      i = end
    }
  }

  for (const seg of segments) {
    if (seg.type === 'ansi') {
      currentLine += seg.value
      tracker.process(seg.value)
      continue
    }

    const grapheme = seg.value
    if (!grapheme) continue

    const graphemeWidthValue = visibleWidth(grapheme)

    if (currentWidth + graphemeWidthValue > width) {
      const lineEndReset = tracker.getLineEndReset()
      if (lineEndReset) {
        currentLine += lineEndReset
      }
      lines.push(currentLine)
      currentLine = tracker.getActiveCodes()
      currentWidth = 0
    }

    currentLine += grapheme
    currentWidth += graphemeWidthValue
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines.length > 0 ? lines : ['']
}

/**
 * Apply background color to a line, padding to full width.
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
  const visibleLen = visibleWidth(line)
  const paddingNeeded = Math.max(0, width - visibleLen)
  const padding = ' '.repeat(paddingNeeded)
  return bgFn(line + padding)
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
  if (maxWidth <= 0 || text.length === 0) {
    return { text: '', width: 0 }
  }

  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth)
    return { text: clipped, width: clipped.length }
  }

  const hasAnsi = text.includes('\x1b')
  const hasTabs = text.includes('\t')
  if (!hasAnsi && !hasTabs) {
    let result = ''
    let width = 0
    for (const { segment } of segmenter.segment(text)) {
      const w = graphemeWidth(segment)
      if (width + w > maxWidth) {
        break
      }
      result += segment
      width += w
    }
    return { text: result, width }
  }

  let result = ''
  let width = 0
  let i = 0
  let pendingAnsi = ''
  const extractAnsi = createAnsiCodeExtractor(text)

  while (i < text.length) {
    const ansi = extractAnsi(i)
    if (ansi) {
      pendingAnsi += ansi.code
      i += ansi.length
      continue
    }

    if (text[i] === '\t') {
      if (width + 3 > maxWidth) {
        break
      }
      if (pendingAnsi) {
        result += pendingAnsi
        pendingAnsi = ''
      }
      result += '\t'
      width += 3
      i++
      continue
    }

    let end = i
    while (end < text.length && text[end] !== '\t') {
      const nextAnsi = extractAnsi(end)
      if (nextAnsi) {
        break
      }
      end++
    }

    for (const { segment } of segmenter.segment(text.slice(i, end))) {
      const w = graphemeWidth(segment)
      if (width + w > maxWidth) {
        return { text: result, width }
      }
      if (pendingAnsi) {
        result += pendingAnsi
        pendingAnsi = ''
      }
      result += segment
      width += w
    }
    i = end
  }

  return { text: result, width }
}

function finalizeTruncatedResult(
  prefix: string,
  prefixWidth: number,
  ellipsis: string,
  ellipsisWidth: number,
  maxWidth: number,
  pad: boolean,
): string {
  const reset = '\x1b[0m'
  const visibleLen = prefixWidth + ellipsisWidth
  const prefixHasAnsi = prefix.includes('\x1b')
  const ellipsisHasAnsi = ellipsis.includes('\x1b')
  const beforeEllipsis = prefixHasAnsi ? reset : ''
  const afterEllipsis = prefixHasAnsi || ellipsisHasAnsi ? reset : ''
  const result =
    ellipsis.length > 0 ? `${prefix}${beforeEllipsis}${ellipsis}${afterEllipsis}` : `${prefix}${beforeEllipsis}`

  return pad ? result + ' '.repeat(Math.max(0, maxWidth - visibleLen)) : result
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if
 * needed. Optionally pad with spaces to reach exactly maxWidth. ANSI escape
 * codes do not count toward width.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = '...',
  pad: boolean = false,
): string {
  if (maxWidth <= 0) {
    return ''
  }

  if (text.length === 0) {
    return pad ? ' '.repeat(maxWidth) : ''
  }

  const ellipsisWidth = visibleWidth(ellipsis)
  if (ellipsisWidth >= maxWidth) {
    const textWidth = visibleWidth(text)
    if (textWidth <= maxWidth) {
      return pad ? text + ' '.repeat(maxWidth - textWidth) : text
    }

    const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth)
    if (clippedEllipsis.width === 0) {
      return pad ? ' '.repeat(maxWidth) : ''
    }
    return finalizeTruncatedResult('', 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad)
  }

  if (isPrintableAscii(text)) {
    if (text.length <= maxWidth) {
      return pad ? text + ' '.repeat(maxWidth - text.length) : text
    }
    const targetWidth = maxWidth - ellipsisWidth
    return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad)
  }

  const targetWidth = maxWidth - ellipsisWidth
  let result = ''
  let pendingAnsi = ''
  let visibleSoFar = 0
  let keptWidth = 0
  let keepContiguousPrefix = true
  let overflowed = false
  let exhaustedInput = false
  const hasAnsi = text.includes('\x1b')
  const hasTabs = text.includes('\t')

  if (!hasAnsi && !hasTabs) {
    for (const { segment } of segmenter.segment(text)) {
      const width = graphemeWidth(segment)
      if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
        result += segment
        keptWidth += width
      } else {
        keepContiguousPrefix = false
      }
      visibleSoFar += width
      if (visibleSoFar > maxWidth) {
        overflowed = true
        break
      }
    }
    exhaustedInput = !overflowed
  } else {
    let i = 0
    const extractAnsi = createAnsiCodeExtractor(text)
    while (i < text.length) {
      const ansi = extractAnsi(i)
      if (ansi) {
        pendingAnsi += ansi.code
        i += ansi.length
        continue
      }

      if (text[i] === '\t') {
        if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi
            pendingAnsi = ''
          }
          result += '\t'
          keptWidth += 3
        } else {
          keepContiguousPrefix = false
          pendingAnsi = ''
        }
        visibleSoFar += 3
        if (visibleSoFar > maxWidth) {
          overflowed = true
          break
        }
        i++
        continue
      }

      let end = i
      while (end < text.length && text[end] !== '\t') {
        const nextAnsi = extractAnsi(end)
        if (nextAnsi) {
          break
        }
        end++
      }

      for (const { segment } of segmenter.segment(text.slice(i, end))) {
        const width = graphemeWidth(segment)
        if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi
            pendingAnsi = ''
          }
          result += segment
          keptWidth += width
        } else {
          keepContiguousPrefix = false
          pendingAnsi = ''
        }

        visibleSoFar += width
        if (visibleSoFar > maxWidth) {
          overflowed = true
          break
        }
      }
      if (overflowed) {
        break
      }
      i = end
    }
    exhaustedInput = i >= text.length
  }

  if (!overflowed && exhaustedInput) {
    return pad ? text + ' '.repeat(Math.max(0, maxWidth - visibleSoFar)) : text
  }

  return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad)
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(
  line: string,
  startCol: number,
  length: number,
  strict = false,
): { text: string; width: number } {
  if (length <= 0) return { text: '', width: 0 }
  const endCol = startCol + length
  let result = '',
    resultWidth = 0,
    currentCol = 0,
    i = 0,
    pendingAnsi = ''
  const extractAnsi = createAnsiCodeExtractor(line)

  while (i < line.length) {
    const ansi = extractAnsi(i)
    if (ansi) {
      if (currentCol >= startCol && currentCol < endCol) result += ansi.code
      else if (currentCol < startCol) pendingAnsi += ansi.code
      i += ansi.length
      continue
    }

    let textEnd = i
    while (textEnd < line.length && !extractAnsi(textEnd)) textEnd++

    for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
      const w = graphemeWidth(segment)
      const inRange = currentCol >= startCol && currentCol < endCol
      const fits = !strict || currentCol + w <= endCol
      if (inRange && fits) {
        if (pendingAnsi) {
          result += pendingAnsi
          pendingAnsi = ''
        }
        result += segment
        resultWidth += w
      }
      currentCol += w
      if (currentCol >= endCol) break
    }
    i = textEnd
    if (currentCol >= endCol) break
  }
  return { text: result, width: resultWidth }
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
  return sliceWithWidth(line, startCol, length, strict).text
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
const pooledStyleTracker = new AnsiCodeTracker()

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the
 * overlay region. Preserves styling from before the overlay that should
 * affect content after it.
 */
export function extractSegments(
  line: string,
  beforeEnd: number,
  afterStart: number,
  afterLen: number,
  strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
  let before = '',
    beforeWidth = 0,
    after = '',
    afterWidth = 0
  let currentCol = 0,
    i = 0
  let pendingAnsiBefore = ''
  let afterStarted = false
  const afterEnd = afterStart + afterLen
  const extractAnsi = createAnsiCodeExtractor(line)

  pooledStyleTracker.clear()

  while (i < line.length) {
    const ansi = extractAnsi(i)
    if (ansi) {
      pooledStyleTracker.process(ansi.code)
      if (currentCol < beforeEnd) {
        pendingAnsiBefore += ansi.code
      } else if (currentCol >= afterStart && currentCol < afterEnd && afterStarted) {
        after += ansi.code
      }
      i += ansi.length
      continue
    }

    let textEnd = i
    while (textEnd < line.length && !extractAnsi(textEnd)) textEnd++

    for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
      const w = graphemeWidth(segment)

      if (currentCol < beforeEnd) {
        if (pendingAnsiBefore) {
          before += pendingAnsiBefore
          pendingAnsiBefore = ''
        }
        before += segment
        beforeWidth += w
      } else if (currentCol >= afterStart && currentCol < afterEnd) {
        const fits = !strictAfter || currentCol + w <= afterEnd
        if (fits) {
          if (!afterStarted) {
            after += pooledStyleTracker.getActiveCodes()
            afterStarted = true
          }
          after += segment
          afterWidth += w
        }
      }

      currentCol += w
      if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break
    }
    i = textEnd
    if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break
  }

  return { before, beforeWidth, after, afterWidth }
}
