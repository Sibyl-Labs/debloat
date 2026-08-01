# debloat

**Context hygiene for AI coding agents.** Measure the files your agent re-reads on every session
start, and trim the accreted history out of them, without deleting anything.

Your AI coding agent (Claude Code, Cursor, and friends) loads a set of instruction, rule, and
state files on **every** session start. That "always-load surface" quietly grows: a `CLAUDE.md`
that accretes months of notes, a rules file that never gets pruned, state files carrying old
narrative. The heavier it gets, the more of every session's context window is spent before you
type a word.

`debloat` measures that surface deterministically and helps you keep it light.

- **Deterministic.** Pure byte/token arithmetic (`chars / 4`, labelled `MEASURED~`). No LLM
  judgment, so the number cannot be rationalized away.
- **Non-blocking.** It measures and suggests. You choose what to trim. It never forces anything.
- **Loss-free.** Trimming means moving accreted *history* into a `*-history` file and leaving a
  one-line pointer. Nothing is deleted.
- **Zero dependencies.** A single Node script (Node 18+).

## Install

**As a Claude Code skill (recommended).** Copy the `debloat/` folder into your project's
`.claude/skills/`:

```
your-project/
  .claude/
    skills/
      debloat/
        SKILL.md
        context-hygiene.mjs
```

Then invoke it with `/debloat`, or wire the one-line check into a session-start hook.

**Standalone (any agent, or just your shell).** It is one dependency-free Node script. Run it
directly:

```
node context-hygiene.mjs          # full report
node context-hygiene.mjs --fyi    # one line
node context-hygiene.mjs --json   # machine-readable
```

## Configure

Tell `debloat` which files are "always-loaded" via a `.debloat.json` in your project root:

```json
{
  "surface": ["CLAUDE.md", "AGENTS.md", ".claude/rules.md"],
  "thresholds": { "watch": 45000, "heavy": 55000 },
  "perFileSoft": { "CLAUDE.md": 6000 }
}
```

| Key | Meaning |
|-----|---------|
| `surface` | The files loaded on every session start. Defaults to `CLAUDE.md` + `AGENTS.md`. |
| `thresholds` | Token weight labels: `light` < `watch`, `watch` >= `watch` (or a heavy file present), `heavy` >= `heavy`. |
| `perFileSoft` | Per-file soft ceilings. A file over its ceiling is flagged as a trim target. |
| `journal` | Optional path for append-only weight telemetry. Off by default. |

No config? It measures `CLAUDE.md` + `AGENTS.md` with sensible defaults. CLI overrides:
`--include <path>` (repeatable), `--root <dir>`, `--config <path>`.

## Usage

### One-line check (session-start hook)

```
$ node .claude/skills/debloat/context-hygiene.mjs --fyi
context: ~48.3k tok always-load (watch) | heavy: rules.md 10223t - /debloat to trim
```

### Full report

```
$ node .claude/skills/debloat/context-hygiene.mjs
============================================================
CONTEXT WEIGHT  2026-08-01T00:00:00.000Z
============================================================
  always-load surface: 48,300 tok  (~189 KB)   [MEASURED~ chars/4]
  reference: light <45k / watch <55k / heavy >=55k
  weight: watch

  file weights (heaviest first):
     10223 tok  .claude/rules.md   <-- heavy (soft 6000)
      ...
  suggested trim targets (you choose what moves):
    * .claude/rules.md is 10223 tok (soft 6000). Move accreted history to a *-history file; keep current state + a pointer.
```

### Interactive trim (via the skill)

Invoke `/debloat` in Claude Code. It measures, shows you the heaviest files and suggested targets,
asks which to trim, then for each one moves the accreted history into a `*-history` file and leaves
a pointer, re-measuring so you see the drop.

## The trim discipline

1. Identify the **accreted history** in a heavy file (dated log prose, superseded notes) versus its
   **current state**.
2. Append that history to a matching `*-history` file (create if absent).
3. Leave the source file with current state + a one-line pointer to the history.
4. **Never delete.** Never trim immutable or append-only records, or transaction data.

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Sibyl Labs](https://sibyllabs.org).
