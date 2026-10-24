#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { TrimPlanError, applyTrim, loadTrimPlan, prepareTrim, renderTrimDiff } from './lib/trim-plan.mjs';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (hasFlag('--help')) {
  console.log(`Usage: node trim-context.mjs --plan <path> [--dry-run | --apply --review-token <sha>] [--root <dir>]

Options:
  --plan <path>         JSON trim plan with source, history, pointer, and ranges
  --dry-run             Validate the plan and print the complete affected diff
  --apply               Back up, apply, hash, and verify the reviewed trim
  --review-token <sha>  Bind --apply to the exact dry-run source, history, and plan
  --root <dir>          Set the project root
  --json                Print the apply result as JSON
  --help                Show this help`);
  process.exit(0);
}

const dryRun = hasFlag('--dry-run');
const apply = hasFlag('--apply');
if (dryRun === apply) {
  console.error('debloat: choose exactly one of --dry-run or --apply');
  process.exit(1);
}

const planPath = option('--plan', null);
if (!planPath) {
  console.error('debloat: --plan <path> is required');
  process.exit(1);
}

const requestedRoot = path.resolve(option('--root', process.cwd()));
if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
  console.error(`debloat: root must be an existing directory: ${requestedRoot}`);
  process.exit(1);
}
const root = fs.realpathSync(requestedRoot);
try {
  const plan = loadTrimPlan({ root, planPath });
  const prepared = prepareTrim({ root, plan });
  if (dryRun) {
    console.log(renderTrimDiff(prepared));
    console.log(`review token: ${prepared.review_token}`);
    process.exit(0);
  }
  const result = applyTrim(prepared, option('--review-token', null));
  if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`trim applied and verified`);
    console.log(`backup: ${result.backup}`);
    console.log(`source sha256: ${result.hashes.source_after}`);
    console.log(`history sha256: ${result.hashes.history_after}`);
  }
} catch (error) {
  const message = error instanceof TrimPlanError ? error.message : `unexpected trim error: ${error.message}`;
  console.error(`debloat: ${message}`);
  process.exit(1);
}
