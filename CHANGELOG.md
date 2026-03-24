# Changelog

## 0.4.1

- **Settings menu cleanup** — removed duplicate auto-augment toggle. Previously, `/gitnexus settings` showed an auto-augment toggle in the top-level menu *and* inside the Settings panel. The top-level toggle is removed; auto-augment is now configured only in the Settings panel alongside timeout and limit options.
- **`/gitnexus` opens main menu** — running `/gitnexus` with no arguments now opens an interactive menu with **Status** and **Settings** choices instead of printing status directly. `/gitnexus status` still works as a direct shortcut.

## 0.4.0

- **`read_many` augmentation** — batch file reads now trigger per-file labeled graph context. When the agent reads multiple files at once via `read_many`, each code file in the batch (up to 5) is looked up in the knowledge graph and returned as a separate `### filename` section, so the agent always knows which context belongs to which file.

## 0.3.1

- **Package metadata** — added `repository`, `homepage`, and `bugs` fields.

## 0.3.0

- **Configurable command** — the gitnexus binary invocation is now configurable. Default is `gitnexus` on PATH. Use `/gitnexus config` to set a custom command (e.g. `npx gitnexus@latest`) via an input dialog; the value is persisted to `~/.pi/pi-gitnexus.json`. The `--gitnexus-cmd` CLI flag overrides the saved config for one-off runs. Nothing is ever installed automatically.
- **TypeScript compatibility** — `tool_result` handler now uses inferred event types from the API overload instead of a manual annotation, fixing a compile error with `@mariozechner/pi-coding-agent` 0.54.x.
- **Dependency updates** — `@mariozechner/pi-coding-agent` to 0.54.2, `@types/node` to 25.x.

## 0.2.0

### Features

- **`read` tool augmentation** — file reads now trigger augmentation. When the agent reads a code file (`.sol`, `.ts`, `.go`, etc.), the filename is used as the lookup pattern to get callers/callees for that file's symbols.
- **Bash `cat`/`head`/`tail` support** — extractPattern now handles `cat file.sol`, `head file.sol`, etc. alongside grep/rg/find.
- **Multi-pattern augmentation** — each tool result now augments up to 3 patterns in parallel: the primary pattern from the tool input, plus filenames extracted from grep output lines (`path/file.sol:line:`). Results are merged into a single `[GitNexus]` block.
- **Session dedup cache** — each symbol/filename is augmented at most once per session, preventing redundant lookups when the agent repeatedly searches for the same thing.

### Fixes

- **Auto-augment now works** — `gitnexus augment` writes its output to stderr, not stdout. `runAugment` was capturing stdout only, so every augmentation returned empty. Fixed by reading from stderr (`stdio: ['ignore', 'ignore', 'pipe']`).
- **Regex patterns cleaned before augment** — grep/rg patterns like `\bwithdraw\s*\(` are stripped of regex metacharacters before passing to `gitnexus augment`, which expects a plain symbol name.
- **`gitnexus_query` limit raised** — max `limit` parameter increased from 20 to 100. The agent was hitting validation errors when requesting more results.
- **Status counters** — `/gitnexus status` now shows searches intercepted and enrichment count for observability.

## 0.1.0

Initial release.

### Features

- **Auto-augment hook** — intercepts grep, find, and bash tool results and appends knowledge graph context (callers, callees, execution flows) via `gitnexus augment`. Mirrors the Claude Code plugin's PreToolUse integration.
- **Five registered tools** — `gitnexus_list_repos`, `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, `gitnexus_detect_changes` available to the agent with zero setup.
- **stdio MCP client** — tools communicate with `gitnexus mcp` over a stdin/stdout pipe (no network socket, no port). Process is spawned lazily and kept alive for the session.
- **System prompt hint** — when an index is present, appends a one-liner to the agent's system prompt so it understands graph context and knows to use the tools.
- **Session lifecycle** — on session start/switch: resolves full shell PATH (nvm/fnm/volta), probes binary, checks index, notifies status. MCP process restarted on session switch.
- **`/gitnexus` command** with subcommands: `status`, `analyze`, `on`, `off`, `query`, `context`, `impact`, `<pattern>`, `help`.
- **`/gitnexus analyze`** — runs `gitnexus analyze` from within pi with start/completion notifications. Auto-augment is paused for the duration to avoid stale index results.
- **Toggle** — `/gitnexus on` / `/gitnexus off` enables/disables auto-augment without affecting tools. Resets to enabled on session switch.
- **Shell PATH resolution** — spawns `$SHELL -lc 'echo $PATH'` on session start so nvm/fnm/volta-managed binaries are found when pi is launched as a GUI app.
- **Path traversal guard** — `gitnexus_context` file parameter validated to stay within cwd before passing to the MCP server.
- **Graceful failure** — every code path (augment timeout, MCP spawn error, binary missing) returns empty rather than throwing. Extension never breaks the agent's normal flow.
