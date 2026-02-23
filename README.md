# pi-gitnexus

[GitNexus](https://github.com/abhigyanpatwari/GitNexus) knowledge graph integration for [pi](https://github.com/mariozechner/pi). Enriches every search, file read, and symbol lookup with call chains, callers/callees, and execution flows — automatically.

<img height="298" alt="pi-gitnexus screenshot" src="https://github.com/tintinweb/pi-gitnexus/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/49e61667-f508-4d22-abad-05241e414664

> The graph view in the demo is from [gitnexus-web](https://github.com/abhigyanpatwari/GitNexus) and is not part of this extension.

## What it does

When the agent reads a file or runs a search (grep, find, bash), the extension appends graph context from the knowledge graph inline with the results. The agent sees both together and can follow call chains without additional queries.

```
Agent reads auth/session.ts
  → file content returned normally
  → [GitNexus] appended: callers of the module, what it imports, related tests

Agent runs grep("validateUser")
  → grep results returned normally
  → [GitNexus] appended: Called by: login, signup / Calls: checkPermissions, getUser
  → filenames in the grep output are also looked up in parallel
```

Five tools are also registered directly in pi — the agent can use them explicitly for deeper analysis without any setup.

## Requirements

- [gitnexus](https://github.com/abhigyanpatwari/GitNexus) installed globally: `npm i -g gitnexus`
- A GitNexus index in your project: run `/gitnexus analyze`

## Getting started

1. Install gitnexus: `npm i -g gitnexus`
2. Open your project in pi
3. Run `/gitnexus analyze` to build the knowledge graph
4. Done — file reads and searches are now enriched automatically

## What triggers augmentation

| Tool | Pattern used |
|---|---|
| `grep` | Search pattern (regex metacharacters stripped) |
| `bash` with grep/rg | First non-flag argument after `grep`/`rg` |
| `bash` with cat/head/tail | Filename of the target file |
| `bash` with find | Value of `-name`/`-iname` |
| `find` | Glob pattern basename |
| `read` | Filename of the file being read (code files only) |
| Any grep/bash result | Filenames extracted from result lines (`path/file.sol:line:`) |

Each tool result augments up to 3 patterns in parallel. Patterns already augmented this session are skipped.

## Commands

| Command | Description |
|---|---|
| `/gitnexus` | Show index status and session enrichment count |
| `/gitnexus analyze` | Build or rebuild the knowledge graph |
| `/gitnexus on` / `/gitnexus off` | Enable/disable auto-augment (tools unaffected) |
| `/gitnexus <pattern>` | Manual graph lookup for a symbol or pattern |
| `/gitnexus query <text>` | Search execution flows |
| `/gitnexus context <name>` | 360° view of a symbol: callers, callees, processes |
| `/gitnexus impact <name>` | Upstream blast radius of a change |
| `/gitnexus help` | Show command reference |

## Agent tools

The following tools are registered in pi and always available to the agent:

| Tool | Description |
|---|---|
| `gitnexus_list_repos` | List all indexed repositories |
| `gitnexus_query` | Search the knowledge graph for execution flows |
| `gitnexus_context` | 360° view of a symbol: callers, callees, processes |
| `gitnexus_impact` | Blast radius analysis for a symbol |
| `gitnexus_detect_changes` | Map a git diff to affected execution flows |

## How it works

**Auto-augment hook** — fires after every grep/find/bash/read tool result. Extracts up to 3 patterns (primary from input, secondary filenames from result content) and calls `gitnexus augment` for each in parallel. Results are merged into a single `[GitNexus]` block appended to the tool result, so the agent sees it inline.

**Session dedup cache** — each symbol or filename is augmented at most once per session. Prevents redundant lookups when the agent repeatedly searches for the same thing.

**MCP client** — tools (query, context, impact, detect_changes, list_repos) communicate with `gitnexus mcp` over a stdio pipe. The process is spawned lazily on the first tool call and kept alive for the session. No network socket, no port.

**Session lifecycle** — on session start/switch, the extension resolves the full shell PATH (picking up nvm/fnm/volta), probes the binary, checks for an index, and notifies accordingly. The MCP process is restarted with the new working directory.

**Auto-augment toggle** — `/gitnexus off` disables the hook without affecting tools. Useful when the graph output is noisy for a particular task. Resets to enabled on session switch.

**Analyze guard** — auto-augment is paused during `/gitnexus analyze` to avoid injecting stale or partially-built index results.

## License note

This extension (pi-gitnexus) is MIT licensed. [GitNexus](https://github.com/abhigyanpatwari/GitNexus) itself is published under the [PolyForm Noncommercial License](https://polyformproject.org/licenses/noncommercial/1.0.0/) — commercial use requires a separate agreement with its author. Install and use gitnexus in accordance with its license terms.

## Notes

- The index is a static snapshot. Re-run `/gitnexus analyze` after significant code changes. The agent will suggest this when the index appears stale.
- `gitnexus_detect_changes` is a lightweight alternative: pass `git diff HEAD` output to see affected flows without a full reindex.
- `gitnexus_cypher` and `gitnexus_rename` are intentionally not exposed (raw graph access and automated multi-file rename).
- The enrichment is appended to the tool result the agent receives — files on disk and raw tool outputs are never modified.
