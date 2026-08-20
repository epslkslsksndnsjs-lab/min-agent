# min-agent

A lightweight terminal coding assistant. `min-agent` runs an agent loop against
any OpenAI-compatible chat-completions endpoint — it streams model output to a
terminal UI, calls built-in tools, feeds results back, and repeats until the
model finishes.

The TUI is self-built (differential rendering, 16 ms throttling, zero runtime
dependencies). Sessions persist as append-only JSONL transcripts and can be
resumed across restarts. Long conversations are compacted — manually or
automatically — so the context window never silently fills up.

## Features

- **Streaming agent loop** — unified event stream (text deltas, tool calls,
  results, usage, retries) consumed by a full-screen terminal UI.
- **Zero-dependency TUI** — differential renderer with 16 ms throttling, mouse
  support (wheel scroll, drag selection, link clicks), collapsible tool-call
  blocks, and a footer with live token/elapsed stats.
- **OpenAI-compatible** — works with any provider exposing the
  `/chat/completions` SSE format (OpenAI, GLM, DeepSeek, Ollama, …).
- **Persistent sessions** — every turn is appended to a JSONL transcript;
  resume with `--resume <id>`, `--continue`, or double-`Esc` mid-session.
- **Context compaction** — manual `/compact` plus reactive auto-compaction
  with a two-stage fold (stale-tool-result cleanup, then full digest) and a
  circuit breaker.
- **Resilient streaming** — two retry layers (HTTP request, then assistant
  turn) with exponential backoff that honors server `retry-after` headers and
  never retries quota/billing errors.

## Requirements

- Node.js ≥ 20 (tested on macOS; uses `fetch`, `node:util` parseArgs, and
  top-level await).
- A terminal that supports the alternate screen buffer (iTerm2, macOS
  Terminal, kitty, etc.).
- An API key for any OpenAI-compatible model endpoint.

## Quick start

```bash
npm install
npm run build

export MIN_AGENT_API_KEY="sk-..."
export MIN_AGENT_MODEL="glm-5.2"          # any model id your endpoint serves
export MIN_AGENT_BASE_URL="https://api.openai.com/v1"   # or any compatible endpoint

node dist/cli.js          # or: npm link && min-agent
```

Or run straight from source during development:

```bash
npm run dev
```

## Usage

Start a session in the directory you want to work on:

```bash
cd ~/my-project
min-agent
```

Type your request, press Enter, and watch the agent stream. Tool calls appear
as collapsible blocks; click the header to expand/collapse, or use the
expand-all shortcut.

### CLI flags

| Flag              | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `--resume <id>`   | Resume a specific past session                          |
| `--continue`      | Resume the most recently modified session for this cwd  |

### Slash commands

| Command                 | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `/clear [--hard]`       | Start a fresh session. `--hard` also deletes the old transcript file |
| `/compact [instr]`      | Fold the conversation into a summary; optional custom instructions |
| `/quit` (`/exit`)       | Leave the alternate screen and exit                                |

Commands are honored even while the agent is streaming — `/quit` exits
immediately and `/clear` or `/compact` interrupt the live turn and run once it
settles.

### Key bindings

| Key              | Action                                                  |
| ---------------- | ------------------------------------------------------- |
| `Esc` (idle)     | First press arms, second press opens the session picker |
| `Esc` (streaming)| Abort the running turn                                  |
| `Ctrl+C`         | Abort / cancel (contextual)                             |

## Configuration

All configuration is environment variables.

| Variable                      | Default                     | Description                                   |
| ----------------------------- | --------------------------- | --------------------------------------------- |
| `MIN_AGENT_API_KEY`           | —                           | API key (required)                            |
| `MIN_AGENT_MODEL`             | `glm-5.2`                   | Model id served by the endpoint               |
| `MIN_AGENT_BASE_URL`          | `https://api.openai.com/v1` | OpenAI-compatible base URL                    |
| `MIN_AGENT_RETRY`             | `true`                      | Set `false` to disable all retries            |
| `MIN_AGENT_MAX_RETRIES`       | `4`                         | Max retry attempts per request                |
| `MIN_AGENT_BASE_DELAY_MS`     | `1000`                      | Base backoff delay (exponential growth)       |
| `MIN_AGENT_MAX_RETRY_DELAY_MS`| `60000`                     | Cap on backoff delay                          |
| `MIN_AGENT_CONTEXT_WINDOW`    | `128000`                    | Assumed context window for auto-compaction    |
| `MIN_AGENT_AUTOCOMPACT_BUFFER`| `13000`                     | Tokens kept in reserve before the window cap  |
| `MIN_AGENT_DISABLE_AUTO_COMPACT` | `false`                 | `true` turns off reactive auto-compaction     |
| `MIN_AGENT_FAKE`              | —                           | `1` uses a synthetic event stream (dev/testing)|
| `MIN_AGENT_HARDWARE_CURSOR`   | —                           | `1` shows the hardware cursor in the TUI      |
| `MIN_AGENT_CLEAR_ON_SHRINK`   | —                           | `1` clears empty rows when content shrinks    |

## Sessions

Each session is a JSONL transcript (one JSON message per line, linked by a
`parentUuid` chain) under:

```
~/.min-agent/projects/<cwd-path>/<session-id>.jsonl
```

Writes are batched on a timer so the agent loop never blocks on disk I/O. A
resumed session replays its transcript at boot, and new turns keep extending
the same chain.

## Built-in tools

| Tool          | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `read_file`   | Read files with line numbers; offset/limit slicing; size and token caps; device-file guard |
| `write_file`  | Write or overwrite a file (creates parent directories)         |
| `edit`        | Exact string replacement with replace-all and create-on-empty  |
| `run_bash`    | Shell commands with timeout, output truncation to temp file, and background execution |
| `grep`        | Content search (ripgrep-backed, pure-Node fallback)            |
| `glob`        | File-name pattern matching, newest-first, capped results       |

## Development

```bash
npm run check   # type-check only (tsc --noEmit)
npm test        # vitest unit + integration tests
npm run smoke   # build + tmux-based end-to-end TUI smoke test
```

Test suites cover the LLM/agent/cli layers plus TUI rendering, input, mouse,
and keybinding logic.

## License

MIT
