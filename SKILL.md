---
name: debloat
description: Measure and trim your AI agent's always-load context - the instruction, rule, and state files it reads on every session start. Use when the user says 'debloat', '/debloat', 'context bloat', 'how heavy is my context', 'trim startup context', 'context weight', or 'my startup is bloated'. Environment hygiene, not a gate: it measures and suggests; you choose what to trim.
---

# /debloat - context hygiene for the always-load surface

Deterministically measures what your agent loads on EVERY session start (its instruction files,
rules, and any always-read state files) and, on demand, runs a trim pass you drive. Pure
byte/token arithmetic (chars/4, labelled `MEASURED~`), no LLM judgment, so the number cannot be
rationalized away. Environment hygiene, not a gate: it never blocks a session and never forces a
trim. You choose what (if anything) to move.

Measurement core: `context-hygiene.mjs` (this skill dir). Modes: `--fyi` (one line), `--json`
(drives the trim picker), default (full report).

## Configure the surface (.debloat.json)

The tool measures the files you declare "always-loaded." Put a `.debloat.json` in your project
root:

```json
{
  "surface": ["CLAUDE.md", "AGENTS.md", ".claude/rules.md"],
  "thresholds": { "watch": 45000, "heavy": 55000 },
  "perFileSoft": { "CLAUDE.md": 6000 }
}
```

No config? It defaults to `CLAUDE.md` + `AGENTS.md`. You can also list files on the CLI with
`--include <path>` (repeatable), set the root with `--root <dir>`, and point at a config with
`--config <path>`.

## Two modes

### 1. Startup FYI (one line, ignorable - good for a session-start hook)

```
node .claude/skills/debloat/context-hygiene.mjs --fyi
```

Emits ONE line, e.g. `context: ~48.3k tok always-load (watch) | heavy: rules.md 10223t - /debloat to trim`.
Surface it and move on. It is FYI, not an action item. Weight labels: `light` (< watch) /
`watch` (>= watch, or a heavy file present) / `heavy` (>= heavy).

### 2. On-demand /debloat (interactive trim pass)

1. **Measure** - `node .claude/skills/debloat/context-hygiene.mjs --json`. Parse `total_tok`,
   `weight`, `files[]` (per-file weight), `targets[]` (heavy files).
2. **Show** the weight + the heaviest files + the suggested targets. If `weight === 'light'` and
   no targets, report "light, nothing to trim" and stop.
3. **Ask** which target(s) to trim (never trim without an explicit choice).
4. **Extract** each chosen target:
   - Identify the accreted HISTORY (dated log prose, superseded notes, event history) versus the
     current live state.
   - Append that history to a matching `*-history` file (create if absent). Leave the source file
     with current state + a one-line pointer to the history file.
   - **NEVER delete data.** Extraction = move to history + keep a pointer. Immutable or append-only
     records (logs, transaction/entry data) are off-limits: surface them, do not trim.
5. **Re-measure** with `--json` and report the before/after `total_tok` drop so you see it landed.
   Validate any JSON file you edit (`node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`).

## Rules

- Environment hygiene, never a gate. Non-blocking. You select; nothing is forced.
- Never delete data - extract accreted history to a `*-history` file and leave a pointer.
- Never trim immutable/append-only records or transaction data.
- The token count is `chars/4` (`MEASURED~`), a deterministic proxy, not an exact tokenizer count.
