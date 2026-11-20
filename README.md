# debloat

**Context hygiene for AI coding agents.** Measure the files your agent re-reads on every session
start, and trim the accreted history out of them, without deleting anything.

Your AI coding agent (Claude Code, Codex, Cursor) loads a set of instruction, rule, and state
files on **every** session start. That "always-load surface" quietly grows: a `CLAUDE.md` that
accretes months of notes, a rules file that never gets pruned, state files carrying old narrative.
The heavier it gets, the more of every session's context window is spent before you type a word.

`debloat` measures that surface deterministically and helps you keep it light.

- **Deterministic.** Pure arithmetic: bytes, characters, and a token estimate of `chars / 4`
  (labelled `ESTIMATE~`). No LLM judgment, so the number cannot be rationalized away.
- **Finds the surface for you.** Knows where Claude Code, Codex and Cursor look, and counts a file
  once even when several symlinks point at it.
- **Non-blocking.** It measures and suggests. You choose what to trim. It never forces anything.
- **Loss-free.** Trimming means moving accreted *history* into a `*-history` file and leaving a
  one-line pointer. Nothing is deleted, and the move is previewed, backed up and hash-verified.
- **Zero dependencies.** Two Node scripts and a small `lib/` (Node 18+). No network access.

## Install

**As a skill.** Copy this folder into your agent's skills directory:

```
your-project/
  .claude/skills/debloat/      # Claude Code
  .agents/skills/debloat/      # Codex (or ~/.agents/skills/debloat for all projects)
    SKILL.md
    context-hygiene.mjs
    trim-context.mjs
    lib/
```

Then invoke it with `/debloat` (Claude Code) or `$debloat` (Codex), or wire the one-line check
into a session-start hook. The scripts find `lib/` relative to themselves, so the folder works
from any location.

**Standalone (any agent, or just your shell).** Run the scripts directly:

```
node context-hygiene.mjs                  # full report
node context-hygiene.mjs --fyi            # one line
node context-hygiene.mjs --json           # machine-readable
node context-hygiene.mjs --agent claude   # one agent only
```

## What gets measured

With no config, `debloat` discovers the surface. `--agent <name>` (repeatable) picks the agent;
the default is all three, with each real file counted once.

| Agent | Files counted |
|-------|---------------|
| `claude` | Managed, user (`~/.claude/CLAUDE.md`, or `$CLAUDE_CONFIG_DIR`) and project memory: `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the root and every parent directory. `.claude/rules/**/*.md` without a `paths:` key. Files pulled in by `@path` imports, five hops deep. |
| `codex` | `AGENTS.override.md` or `AGENTS.md` in `~/.codex` (or `$CODEX_HOME`), then one file per directory from the git root down to the root: `AGENTS.override.md`, `AGENTS.md`, or a name from `project_doc_fallback_filenames`. |
| `cursor` | `.cursorrules`, `.cursor/rules/**/*.mdc` with `alwaysApply: true`, and `AGENTS.md` / `CLAUDE.md` in the root. |

Rules scoped to file paths are left out because they are not loaded on every start.

Limits. These are not visible from files and are not counted: the agent's system prompt and tool
definitions, user rules stored in editor settings, and Claude Code auto memory. Codex stops
reading project instructions at `project_doc_max_bytes`; `debloat` measures the whole file. Add
anything else you know is loaded with `--include <path>` or `surface`.

## Configure

Optional. A `.debloat.json` in your project root:

```json
{
  "agents": ["claude"],
  "surface": ["docs/always-loaded-state.md"],
  "discover": true,
  "thresholds": { "watch": 8000, "heavy": 16000 },
  "perFileSoft": { "*": 4000, "CLAUDE.md": 6000 },
  "journal": ".debloat/history.jsonl"
}
```

| Key | Meaning |
|-----|---------|
| `agents` | Agents to discover for: `claude`, `codex`, `cursor`, or `all`. Default: all. |
| `surface` | Extra files loaded on every session start, relative to the root (`~/` works). |
| `discover` | Run discovery. Default: `true` with no `surface`, `false` when `surface` is set, so a declared surface is measured exactly as written. Set `true` to get both. |
| `thresholds` | Token weight labels: `light` < `watch`, `watch` >= `watch` (or a heavy file present), `heavy` >= `heavy`. Default 8000 / 16000. |
| `perFileSoft` | Per-file soft ceilings in tokens, keyed by path; `"*"` is the fallback. A file over its ceiling is flagged as a trim target. Default `{ "*": 4000 }`. Setting this key replaces the default, so include `"*"` if you still want a fallback. |
| `journal` | Optional path for append-only weight telemetry. Must be inside the root. Off by default. |

CLI overrides: `--agent <name>` (repeatable), `--include <path>` (repeatable), `--no-discover`,
`--root <dir>`, `--config <path>`. With `--no-discover` and no `surface`, the script measures
`CLAUDE.md` + `AGENTS.md` in the root, as 1.0 did.

The measurement script always exits 0. A config it cannot use is reported on stderr and replaced
by defaults, so a typo never breaks a session-start hook.

## Usage

### One-line check (session-start hook)

```
$ node .claude/skills/debloat/context-hygiene.mjs --fyi --agent claude
context: ~9.3k tok always-load (watch) | heavy: CLAUDE.md 5210t - /debloat to trim
```

### Full report

```
$ node .claude/skills/debloat/context-hygiene.mjs
============================================================
CONTEXT WEIGHT  2026-11-19T00:00:00.000Z
============================================================
  always-load surface: 9,304 tok   [ESTIMATE~ chars/4]
  measured: 37,216 chars / 37,302 bytes in 3 files
  reference: light <8k / watch <16k / heavy >=16k
  weight: watch

  per agent (a file shared by several agents counts once in the total):
      9304 tok  claude (3 files)
      5210 tok  codex (1 file)
      5210 tok  cursor (1 file)

  file weights (heaviest first):
      5210 tok    20840 ch    20926 B  AGENTS.md  <-- heavy (soft 4000)
                                       same file: CLAUDE.md
      3290 tok    13160 ch    13160 B  .claude/rules/workflow.md  (soft 4000)
       804 tok     3216 ch     3216 B  ~/.claude/CLAUDE.md  (soft 4000)

  suggested trim targets (you choose what moves):
    * AGENTS.md is 5210 tok (soft 4000). Move accreted history to a *-history file; keep current state + a pointer.
```

### JSON

`--json` prints one record. Fields from 1.0 are unchanged (`ts`, `root`, `total_tok`,
`total_bytes`, `ref`, `weight`, `files[].file/tok/soft/heavy`, `targets[]`). New in 1.1: `agents`,
`by_agent`, `total_chars`, `estimate`, `missing`, `warnings`, and per file `chars`, `bytes`,
`agents`, `why` (how it was found), `aliases` (other names for the same file) and `real` (the
target, when the file is reached only through a symlink).

### Interactive trim (via the skill)

Invoke `/debloat`. The agent measures, shows you the heaviest files and suggested targets, asks
which to trim, writes a trim plan, shows you the diff, and applies it only after you approve.
Then it re-measures so you see the drop.

## The trim discipline

1. Identify the **accreted history** in a heavy file (dated log prose, superseded notes) versus its
   **current state**.
2. Append that history to a matching `*-history` file (create if absent).
3. Leave the source file with current state + a one-line pointer to the history.
4. **Never delete.** Never trim immutable or append-only records, or transaction data.

## Verified trim (trim-context.mjs)

`trim-context.mjs` carries out steps 2 and 3 mechanically, so the move is exact and checkable.
You, or your agent, decide which lines are history. The script does the rest.

Write a plan. Line numbers are 1-based and inclusive:

```json
{
  "source": "CLAUDE.md",
  "history": "CLAUDE-history.md",
  "pointer": "Older notes: see CLAUDE-history.md.",
  "ranges": [{ "start": 42, "end": 78 }]
}
```

Preview it. This reads only, and prints the diff plus a review token:

```
$ node trim-context.mjs --plan .debloat/trim-plan.json --dry-run
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -42,37 +42,1 @@
-## 2025 log
-...
+Older notes: see CLAUDE-history.md.
--- /dev/null
+++ b/CLAUDE-history.md
@@ -0,0 +1,39 @@
+<!-- debloat:start source="CLAUDE.md" lines=42-78 sha256=9f2c... -->
+## 2025 log
+...
+<!-- debloat:end -->

dry run: nothing written. 37 lines would move from CLAUDE.md to CLAUDE-history.md (20840 -> 14102 chars).
review token: 4be1...
```

Apply it with that token:

```
$ node trim-context.mjs --plan .debloat/trim-plan.json --apply --review-token 4be1...
trim applied and verified: 37 lines moved from CLAUDE.md to CLAUDE-history.md (20840 -> 14102 chars).
backup: .debloat/backups/2026-11-19T00-00-00-000Z-a1b2c3
```

What the script guarantees:

- **You apply what you previewed.** The review token is a SHA-256 over the plan, the current
  content of both files and the content that would be written. If the plan, the source or the
  history changes after the dry run, apply refuses and writes nothing. Run the dry run again.
- **It stays in the project.** Source, history and backups must resolve inside the root. A path
  with `..`, an absolute path elsewhere, or a symlink that points outside the root is refused. A
  symlink that stays inside the root is trimmed at its target.
- **Backup before write.** Source and history are copied to `.debloat/backups/<timestamp>/` with a
  manifest of hashes, and the copies are verified before anything is changed.
- **Atomic writes.** Each file is written to a temp file, synced, and renamed into place. The
  history file is written first, so an interruption can leave the moved lines in both files but
  never in neither.
- **Verification and rollback.** Both files are re-read from disk and compared with the previewed
  hashes, and each moved block is checked in the history file. On any mismatch or write error both
  files are restored and the command exits 1.
- **Text only.** Files that are not valid UTF-8, and `.json` / `.jsonl` files, are refused.

The pointer is inserted where the first range was. If the same pointer line is already in the
file, it is not added again. Add `.debloat/` to your `.gitignore` unless you want backups in
version control. To undo a trim, copy the files back from the backup directory.

## Development

```
npm test
```

Runs the test suite with Node's built-in runner. The tests use temp directories and a fake home;
they do not touch your real agent config.

## Credits

Multi-agent discovery and the verified trim workflow are based on a contribution by @slrt4713-cmyk.

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Sibyl Labs](https://sibyllabs.org).
