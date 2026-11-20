#!/usr/bin/env node
// trim-context.mjs - verified trim: move chosen line ranges out of an always-load file into a
// history file, leaving a one-line pointer. Nothing is deleted.
//
// Two steps, always in this order:
//   --dry-run   read-only. Validates the plan, prints the exact diff and a review token.
//   --apply     writes, but only with the --review-token from a dry run of the same plan against
//               the same file content. Backs up first, writes atomically, verifies SHA-256 hashes
//               from disk and rolls back on any mismatch.
//
// Plan (JSON, line numbers 1-based and inclusive):
//   { "source": "CLAUDE.md",
//     "history": "CLAUDE-history.md",
//     "pointer": "Older notes: see CLAUDE-history.md.",
//     "ranges": [{ "start": 42, "end": 78 }] }
//
// Source, history and backups must resolve inside the root; symlinks pointing out are refused.
// Backups land in <root>/.debloat/backups/. Unlike the measurement script, this one exits 1 on
// any refusal or failure. Node 18+ (no dependencies).
// Usage: node trim-context.mjs --plan <path> (--dry-run | --apply --review-token <token>) [--root <dir>] [--json]

import path from 'node:path';
import { TrimError, apply, loadPlan, prepare, renderDiff } from './lib/trim.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const fail = (msg) => { console.error(`debloat: ${msg}`); process.exit(1); };

if (flag('--help') || flag('-h')) {
  console.log(`Usage: node trim-context.mjs --plan <path> (--dry-run | --apply --review-token <token>) [options]

  --plan <path>           JSON trim plan: source, history, pointer, ranges
  --dry-run               validate the plan, print the diff and the review token (writes nothing)
  --apply                 back up, write, verify, roll back on failure
  --review-token <token>  the token printed by --dry-run; required with --apply
  --root <dir>            project root (default: current directory)
  --json                  machine-readable output`);
  process.exit(0);
}

if (flag('--dry-run') === flag('--apply')) fail('choose exactly one of --dry-run or --apply');

try {
  const root = path.resolve(opt('--root', process.cwd()));
  const prepared = prepare({ root, plan: loadPlan({ root, planPath: opt('--plan', null) }) });
  const moved = `${prepared.lines_moved} line${prepared.lines_moved === 1 ? '' : 's'}`;
  const drop = `${prepared.source_chars.before} -> ${prepared.source_chars.after} chars`;

  if (flag('--dry-run')) {
    const diff = renderDiff(prepared);
    if (flag('--json')) {
      console.log(JSON.stringify({ dry_run: true, source: prepared.source.label, history: prepared.history.label,
        lines_moved: prepared.lines_moved, source_chars: prepared.source_chars, pointer_added: prepared.pointer_added,
        hashes: prepared.hashes, review_token: prepared.review_token, diff }, null, 2));
    } else {
      process.stdout.write(diff);
      console.log('');
      console.log(`dry run: nothing written. ${moved} would move from ${prepared.source.label} to ${prepared.history.label} (${drop}).`);
      console.log(`review token: ${prepared.review_token}`);
    }
    process.exit(0);
  }

  const result = apply(prepared, opt('--review-token', null));
  if (flag('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`trim applied and verified: ${moved} moved from ${result.source} to ${result.history} (${drop}).`);
    console.log(`backup: ${result.backup}`);
    console.log(`source sha256:  ${result.hashes.source_after}`);
    console.log(`history sha256: ${result.hashes.history_after}`);
  }
} catch (e) {
  fail(e instanceof TrimError ? e.message : `unexpected error: ${e.message}`);
}
