# debloat

Context hygiene for AI coding agents. Measure persistent instruction files, find accumulated
history, and move selected line ranges through a previewed, backed-up, verified workflow.

`debloat` supports Codex, Claude Code, Cursor, and standalone use. It has no runtime dependencies
and requires Node.js 18 or newer.

## What changed in v1.1

- Discovers agent-specific instruction files.
- Deduplicates symlinks by real path.
- Reports UTF-8 bytes, Unicode characters, and estimated tokens separately.
- Uses configurable defaults of 8k tokens for `watch`, 16k for `heavy`, and 4k per file.
- Provides deterministic trim plans with a read-only diff.
- Creates backups before writing and verifies SHA-256 hashes after writing.
- Includes Node tests for Unicode, symlinks, discovery, invalid config, missing files, and trims.
- Works from both Claude Code and Codex skill locations.

## Install as a skill

Copy this directory into the location used by your agent.

Claude Code project skill:

```text
.claude/skills/debloat/
```

Codex project skill:

```text
.agents/skills/debloat/
```

Codex user skill:

```text
~/.agents/skills/debloat/
```

Invoke `debloat` from Claude Code or `$debloat` from Codex. The instructions resolve scripts from
the installed skill directory instead of assuming one agent-specific path.

## Measure

Run automatic discovery:

```bash
node context-hygiene.mjs
node context-hygiene.mjs --fyi
node context-hygiene.mjs --json
```

Limit discovery to one agent:

```bash
node context-hygiene.mjs --agent codex
node context-hygiene.mjs --agent claude
node context-hygiene.mjs --agent cursor
```

The JSON report keeps the v1 `total_tok`, `tok`, `ref`, `files`, and `targets` fields while adding
explicit `total_tokens_estimate`, `total_characters`, `total_bytes`, aliases, discovery reasons,
and missing files.

The estimate is `Unicode characters / 4`, labelled `ESTIMATED~`. It is deterministic but is not an
exact model tokenizer count. Bytes and characters remain visible so multilingual files do not get
silently measured as ASCII.

## Discovery

Automatic mode checks all supported agent conventions and counts each real file once.

| Agent | Discovered surface |
| --- | --- |
| Codex | Global instructions plus the active `AGENTS.override.md`, `AGENTS.md`, or configured fallback at each project level |
| Claude Code | Managed, user, ancestor, local, imported, and unconditional `.claude/rules/*.md` instructions |
| Cursor | Root CLI rules, legacy `.cursorrules`, and `.cursor/rules/*.mdc` files with `alwaysApply: true` |

Conditional Claude and Cursor rules are excluded because they are not always loaded. Runtime user
rules stored inside an editor, agent system prompts, and conditionally injected context cannot be
measured from repository files. Use `--include <path>` for additional known files.

## Configure

Create `.debloat.json` in the inspected root:

```json
{
  "agents": ["codex"],
  "discover": true,
  "surface": ["docs/always-loaded-state.md"],
  "thresholds": { "watch": 8000, "heavy": 16000 },
  "perFileSoft": { "*": 4000, "AGENTS.md": 6000 },
  "journal": ".debloat/history.jsonl"
}
```

| Key | Meaning |
| --- | --- |
| `agents` | `codex`, `claude`, `cursor`, `auto`, or `all` |
| `discover` | Enable agent-specific discovery |
| `surface` | Additional files to measure |
| `thresholds` | Total estimated-token levels for `watch` and `heavy` |
| `perFileSoft` | Per-file soft ceilings, with `*` as the fallback |
| `journal` | Optional append-only telemetry path inside the inspected root |

Use `--no-discover` to measure only `surface` and `--include` entries. Invalid configuration exits
with an error instead of silently falling back.

## Preview and apply a trim

Create a plan with inclusive, one-based line ranges:

```json
{
  "source": "AGENTS.md",
  "history": "AGENTS-history.md",
  "pointer": "Historical notes: see [AGENTS-history.md](AGENTS-history.md).",
  "ranges": [{ "start": 42, "end": 78 }]
}
```

Preview the complete affected diff without changing files:

```bash
node trim-context.mjs --plan .debloat/trim-plan.json --dry-run
```

After reviewing the diff, apply it:

```bash
node trim-context.mjs --plan .debloat/trim-plan.json --apply --review-token <token-from-dry-run>
```

The dry run prints the review token. It hashes the source, existing history, and normalized plan.
If any of them changes before apply, the command refuses to write and requires a new preview.

The apply command:

1. Resolves and validates all paths inside the project root.
2. Confirms that the review token and current files match the preview.
3. Creates `.debloat/backups/<timestamp>/` before changing files.
4. Copies the original source and existing history file into the backup.
5. Appends selected lines unchanged inside marked history blocks.
6. Replaces the selected ranges with one pointer.
7. Writes atomically and verifies source, history, backup, and extracted content.
8. Restores the original files if verification fails.

Never use trim plans for immutable logs, transaction data, generated audit records, or any content
whose retention rules are uncertain.

## Test

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).

Built by [Sibyl Labs](https://sibyllabs.org).
