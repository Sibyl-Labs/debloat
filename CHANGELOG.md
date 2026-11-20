# Changelog

## 1.1.0 - 2026-11-19

Based on PR #1 by @slrt4713-cmyk. Thank you.

### Added

- Discovery of the always-load surface for Claude Code, Codex and Cursor. `--agent <name>`
  (repeatable) narrows it to one agent, `--no-discover` turns it off. Covers user and project
  memory, unconditional rules, Claude `@imports` (five hops), Codex global and per-directory
  instructions with override and fallback names, and Cursor always-apply rules.
- Symlinks are de-duplicated by real path. A file reached under three names is counted once and
  listed with its aliases.
- UTF-8 bytes, Unicode characters and estimated tokens are reported separately, per file and in
  total. Per-agent subtotals are shown when more than one agent is measured.
- `trim-context.mjs`: a deterministic trim. A JSON plan names the source, the history file, a
  pointer line and the line ranges to move. `--dry-run` prints the exact diff and a review token.
  `--apply` requires that token, takes a verified backup, writes atomically, checks SHA-256 hashes
  from disk and rolls back on any mismatch.
- Config keys `agents` and `discover`. `perFileSoft` accepts `"*"` as a fallback ceiling and
  matches files by path through any alias.
- JSON output adds `agents`, `by_agent`, `total_chars`, `estimate`, `missing`, `warnings`, and per
  file `chars`, `bytes`, `agents`, `why`, `aliases` and `real`.
- Tests (`npm test`, Node's built-in runner) and a `package.json`.
- `agents/openai.yaml` so the skill shows up with a name and description in Codex.

### Changed

- Default thresholds are now 8k `watch` and 16k `heavy` (were 45k and 55k), with a 4k per-file
  soft ceiling when `perFileSoft` is not configured. The old defaults were sized for a surface of
  many state files and almost never fired for a plain instruction file. Configs that set
  `thresholds` or `perFileSoft` keep their own values.
- With no `surface` configured, the surface is discovered instead of being fixed to `CLAUDE.md`
  and `AGENTS.md` in the root. A configured `surface` is still measured exactly as declared.
  `--no-discover` restores the 1.0 default.
- The token estimate is characters / 4, not bytes / 4. The two are equal for ASCII; multilingual
  files are no longer overcounted. The report labels the figure `ESTIMATE~` instead of `MEASURED~`.
- The full report shows characters and bytes and lists files with their aliases.
- A `journal` path must resolve inside the root. Paths outside it are skipped with a warning.
- Invalid config values are reported on stderr and replaced by defaults, key by key.
- The skill instructions refer to the installed skill directory, so they work from
  `.claude/skills/`, `.agents/skills/` or anywhere else.

### Unchanged

- The measurement script always exits 0. `--fyi`, `--json`, `--root`, `--config` and `--include`
  work as before, the `--fyi` line has the same format, and every 1.0 JSON field is still present.

## 1.0.0 - 2026-07-31

Initial release.

- `context-hygiene.mjs`: a single dependency-free Node script that measures the files an agent
  loads on every session start and labels the total `light`, `watch` or `heavy`.
- Three output modes: full report, `--fyi` (one line for a session-start hook) and `--json`.
- `.debloat.json` config: `surface`, `thresholds`, `perFileSoft` and an optional append-only
  `journal`. CLI overrides `--root`, `--config` and `--include`.
- `SKILL.md`: the `/debloat` skill, an interactive trim pass that moves accreted history into a
  `*-history` file and leaves a pointer. Nothing is deleted.
