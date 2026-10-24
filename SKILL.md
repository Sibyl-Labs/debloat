---
name: debloat
description: Measure and safely trim the instruction, rule, and state files that AI coding agents load into every session. Use for debloat, /debloat, context bloat, startup context, context weight, oversized AGENTS.md or CLAUDE.md files, and accumulated agent history. Support Codex, Claude Code, Cursor, and standalone use. Measure first, require an explicit target choice, preview an exact diff, and never trim immutable records.
---

# Debloat agent context

Measure the persistent context surface, identify accumulated history, and move only user-approved
line ranges through a deterministic, backed-up workflow. Treat the token number as an estimate,
not an exact tokenizer count.

The skill directory contains two scripts:

- `context-hygiene.mjs`: discover and measure context files.
- `trim-context.mjs`: preview and apply a verified trim plan.

Run scripts with `node <skill-directory>/<script>`. Do not assume a `.claude` or `.agents` install
path. Use the actual directory containing this `SKILL.md`.

## Measure

1. Select the active agent with `--agent codex`, `--agent claude`, or `--agent cursor`. Use the
   default automatic discovery only when the active agent is unknown.
2. Run:

   ```bash
   node <skill-directory>/context-hygiene.mjs --agent <agent> --json
   ```

3. Report `total_tokens_estimate`, `total_characters`, `total_bytes`, `weight`, the heaviest files,
   duplicate aliases, missing explicit files, and suggested targets.
4. If the surface is light and has no targets, stop.

Discovery follows each agent's current instruction conventions. It includes only unconditional
Claude and Cursor rules. Configured `surface` entries and repeated `--include` values supplement
discovery. Use `--no-discover` to measure only explicit files.

## Prepare a trim

1. Ask which suggested file the user wants to trim. Never infer approval from measurement alone.
2. Read the selected file and separate current instructions from dated logs, superseded notes, and
   event history.
3. Never select immutable logs, transaction records, generated audit trails, secrets, or data whose
   retention semantics are unclear.
4. Create `.debloat/trim-plan.json` with inclusive, one-based line ranges:

   ```json
   {
     "source": "AGENTS.md",
     "history": "AGENTS-history.md",
     "pointer": "Historical notes: see [AGENTS-history.md](AGENTS-history.md).",
     "ranges": [{ "start": 42, "end": 78 }]
   }
   ```

5. Preview the complete affected diff:

   ```bash
   node <skill-directory>/trim-context.mjs --plan .debloat/trim-plan.json --dry-run
   ```

6. Show the diff and ask for explicit approval. Do not edit the source or history file directly.
   Keep the printed review token. It binds approval to the exact source, history, and plan content.

## Apply and verify

After approval, run:

```bash
node <skill-directory>/trim-context.mjs --plan .debloat/trim-plan.json --apply --review-token <token-from-dry-run>
```

The script must create a backup before writing, preserve extracted bytes inside marked history
blocks, write atomically, compare SHA-256 hashes, and roll back on failed verification. It refuses
source symlinks that resolve outside the project root and rejects changes made after preview.

Re-run measurement and report the before and after estimate, changed files, backup directory, and
verification result.

## Configure

Read `.debloat.json` from the inspected root by default:

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

Keep journal paths inside the inspected root. Treat `unicode_characters/4` as a deterministic proxy.
Do not describe it as an exact token count or proof of the context actually injected by an agent.
