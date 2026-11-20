---
name: debloat
description: Measure and trim your AI agent's always-load context - the instruction, rule, and state files it reads on every session start. Works with Claude Code, Codex, and Cursor. Use when the user says 'debloat', '/debloat', 'context bloat', 'how heavy is my context', 'trim startup context', 'context weight', or 'my startup is bloated'. Environment hygiene, not a gate: it measures and suggests; you choose what to trim.
---

# /debloat - context hygiene for the always-load surface

Deterministically measures what your agent loads on EVERY session start (its instruction files,
rules, and any always-read state files) and, on demand, runs a trim pass you drive. Pure
arithmetic, no LLM judgment, so the number cannot be rationalized away. Environment hygiene, not a
gate: it never blocks a session and never forces a trim. You choose what (if anything) to move.

Two scripts live in this skill's directory, next to this `SKILL.md`:

- `context-hygiene.mjs` measures. Modes: `--fyi` (one line), `--json` (drives the trim picker),
  default (full report). Read-only, always exits 0.
- `trim-context.mjs` moves line ranges into a history file: preview first, then a verified apply.

Run them as `node <skill-dir>/<script>`, where `<skill-dir>` is the directory this file is in
(`.claude/skills/debloat`, `.agents/skills/debloat`, or wherever it was installed). Do not assume
one agent's path.

## What gets measured

With no config, the surface is discovered for the agent you name with `--agent`:

| Agent | Files counted |
|-------|---------------|
| `claude` | Managed, user (`~/.claude/CLAUDE.md`) and project `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the root and every parent directory; `.claude/rules/**/*.md` without a `paths:` key; files pulled in by `@path` imports. |
| `codex` | `AGENTS.override.md` or `AGENTS.md` in `~/.codex` (or `$CODEX_HOME`), then one file per directory from the git root down to the root, including configured fallback names. |
| `cursor` | `.cursorrules`, `.cursor/rules/**/*.mdc` with `alwaysApply: true`, and `AGENTS.md` / `CLAUDE.md` in the root. |

Pass `--agent` for the agent you are running as. Without it, all three are measured and the total
is their union. A file reached through several symlinks is counted once. Rules that load only for
matching paths are left out because they are not always-load.

Not measurable from files: the agent's own system prompt, tool definitions, user rules stored in
editor settings, and Claude Code auto memory.

## Configure the surface (.debloat.json)

Optional. Put a `.debloat.json` in the project root:

```json
{
  "agents": ["claude"],
  "surface": ["docs/always-loaded-state.md"],
  "discover": true,
  "thresholds": { "watch": 8000, "heavy": 16000 },
  "perFileSoft": { "*": 4000, "CLAUDE.md": 6000 }
}
```

`surface` lists extra always-loaded files (state files a startup hook reads, for example). A
config with `surface` and no `discover` measures exactly those files and nothing else. CLI:
`--include <path>` (repeatable), `--root <dir>`, `--config <path>`, `--no-discover`.

## Two modes

### 1. Startup FYI (one line, ignorable - good for a session-start hook)

```
node <skill-dir>/context-hygiene.mjs --fyi --agent claude
```

Emits ONE line, e.g. `context: ~9.3k tok always-load (watch) | heavy: CLAUDE.md 5210t - /debloat to trim`.
Surface it and move on. It is FYI, not an action item. Weight labels: `light` (< watch) /
`watch` (>= watch, or a heavy file present) / `heavy` (>= heavy).

### 2. On-demand /debloat (interactive trim pass)

1. **Measure** - `node <skill-dir>/context-hygiene.mjs --json --agent <agent>`. Parse `total_tok`,
   `total_chars`, `total_bytes`, `weight`, `files[]` (per-file weight, `aliases`, `real`),
   `targets[]` (heavy files), `missing[]`.
2. **Show** the weight + the heaviest files + the suggested targets. If `weight === 'light'` and
   no targets, report "light, nothing to trim" and stop.
3. **Ask** which target(s) to trim (never trim without an explicit choice).
4. **Plan** each chosen target. Read the file and identify the accreted HISTORY (dated log prose,
   superseded notes, event history) versus the current live state. Write the line ranges that hold
   history to `.debloat/trim-plan.json` (1-based, inclusive):

   ```json
   {
     "source": "CLAUDE.md",
     "history": "CLAUDE-history.md",
     "pointer": "Older notes: see CLAUDE-history.md.",
     "ranges": [{ "start": 42, "end": 78 }, { "start": 120, "end": 131 }]
   }
   ```

   If a file's `real` field points somewhere else, plan against that path. A source that
   resolves outside the project root is refused: trim it from its own project.
5. **Preview** - `node <skill-dir>/trim-context.mjs --plan .debloat/trim-plan.json --dry-run`.
   This writes nothing. Show the user the diff it prints and ask for approval. Keep the
   `review token` from the last line.
6. **Apply**, only after approval:

   ```
   node <skill-dir>/trim-context.mjs --plan .debloat/trim-plan.json --apply --review-token <token>
   ```

   The token is bound to the plan and to the exact content that was previewed. If the command
   refuses because something changed, run the dry run again and show the new diff. Do not work
   around a refusal by editing the files yourself.
7. **Re-measure** with `--json` and report the before/after `total_tok` drop, the backup
   directory, and that the apply reported `verified`.

What apply does: checks the token, backs up source and history under `.debloat/backups/`, appends
the ranges to the history file inside marked blocks carrying their SHA-256, replaces them in the
source with the pointer, writes both files atomically, re-reads them and compares hashes, and
restores both if anything does not match.

JSON state files are refused by the trim script (moving lines would break them). Trim those by
hand with the same discipline: move history to a `*-history` file, leave a pointer, then validate
(`node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`).

## Rules

- Environment hygiene, never a gate. Non-blocking. You select; nothing is forced.
- Never delete data - extract accreted history to a `*-history` file and leave a pointer.
- Never trim immutable/append-only records, transaction data, audit trails, or anything whose
  retention rules are unclear. Surface them, do not trim.
- Never apply a trim the user has not seen as a diff and approved.
- The token count is `chars/4` (`ESTIMATE~`), a deterministic estimate, not an exact tokenizer
  count. Say "about" when you quote it.
