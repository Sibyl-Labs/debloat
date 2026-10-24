#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DebloatConfigError, loadConfig, measureSurface } from './lib/context-surface.mjs';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const options = (name) => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]] : []);

if (hasFlag('--help')) {
  console.log(`Usage: node context-hygiene.mjs [options]

Options:
  --fyi                 Print one summary line
  --json                Print a machine-readable report
  --root <dir>          Set the working directory to inspect
  --config <path>       Set the config path, relative to root by default
  --agent <name>        Inspect codex, claude, cursor, auto, or all (repeatable)
  --include <path>      Add a file to the measured surface (repeatable)
  --no-discover         Measure only configured and included files
  --help                Show this help`);
  process.exit(0);
}

const requestedRoot = path.resolve(option('--root', process.cwd()));
if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
  console.error(`debloat: root must be an existing directory: ${requestedRoot}`);
  process.exit(1);
}
const root = fs.realpathSync(requestedRoot);
let config;
try {
  config = loadConfig({ root, configPath: option('--config', null) });
} catch (error) {
  const message = error instanceof DebloatConfigError ? error.message : `unexpected config error: ${error.message}`;
  console.error(`debloat: ${message}`);
  process.exit(1);
}

let record;
try {
  record = measureSurface({
    root,
    config,
    includes: options('--include'),
    cliAgents: options('--agent'),
    discover: config.discover && !hasFlag('--no-discover'),
  });
} catch (error) {
  const message = error instanceof DebloatConfigError ? error.message : `measurement failed: ${error.message}`;
  console.error(`debloat: ${message}`);
  process.exit(1);
}

if (config.journal) {
  try {
    const journalPath = path.resolve(root, config.journal);
    const relative = path.relative(root, journalPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('journal must stay inside the inspected root');
    }
    let existingParent = path.dirname(journalPath);
    while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
    const realParent = fs.realpathSync(existingParent);
    const realParentRelative = path.relative(root, realParent);
    if (realParentRelative.startsWith('..') || path.isAbsolute(realParentRelative)) {
      throw new Error('journal parent symlink must stay inside the inspected root');
    }
    if (fs.existsSync(journalPath)) {
      const realJournal = fs.realpathSync(journalPath);
      const realJournalRelative = path.relative(root, realJournal);
      if (realJournalRelative.startsWith('..') || path.isAbsolute(realJournalRelative)) {
        throw new Error('journal symlink must stay inside the inspected root');
      }
    }
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, `${JSON.stringify({
      ts: record.ts,
      total_tokens_estimate: record.total_tokens_estimate,
      total_characters: record.total_characters,
      total_bytes: record.total_bytes,
      weight: record.weight,
      targets: record.targets.length,
    })}\n`);
  } catch (error) {
    console.error(`debloat: could not write journal: ${error.message}`);
    process.exit(1);
  }
}

if (hasFlag('--json')) {
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

if (hasFlag('--fyi')) {
  const heavyFiles = record.files.filter((file) => file.heavy).map((file) => `${path.basename(file.file)} ~${file.estimated_tokens}t`);
  const spots = heavyFiles.length ? ` | heavy: ${heavyFiles.join(', ')}` : '';
  const hint = record.weight === 'light' ? '' : ' | run /debloat to inspect';
  console.log(`context: ~${(record.total_tokens_estimate / 1000).toFixed(1)}k tokens (${record.weight})${spots}${hint}`);
  process.exit(0);
}

const bar = '='.repeat(72);
console.log(bar);
console.log(`CONTEXT WEIGHT  ${record.ts}`);
console.log(bar);
if (!record.files.length) {
  console.log('  no always-load files found');
  console.log('  use --agent, --include, or configure surface in .debloat.json');
  if (record.missing.length) console.log(`  missing explicit files: ${record.missing.join(', ')}`);
  console.log(bar);
  process.exit(0);
}

console.log(`  agents: ${record.agents.join(', ') || 'custom surface only'}`);
console.log(`  estimated tokens: ${record.total_tokens_estimate.toLocaleString()} [ESTIMATED~ unicode characters/4]`);
console.log(`  characters: ${record.total_characters.toLocaleString()}`);
console.log(`  bytes: ${record.total_bytes.toLocaleString()}`);
console.log(`  reference: light <${record.ref.watch.toLocaleString()} / watch <${record.ref.heavy.toLocaleString()} / heavy >=${record.ref.heavy.toLocaleString()}`);
console.log(`  weight: ${record.weight}`);
console.log('');
console.log('  file weights (heaviest first, symlinks counted once):');
for (const file of record.files) {
  const mark = file.heavy ? `  <-- heavy (soft ${file.soft})` : file.soft ? `  (soft ${file.soft})` : '';
  const aliasNote = file.aliases.length > 1 ? `  [aliases: ${file.aliases.slice(1).join(', ')}]` : '';
  console.log(`    ${String(file.estimated_tokens).padStart(6)} tok  ${String(file.characters).padStart(7)} chars  ${String(file.bytes).padStart(7)} bytes  ${file.file}${mark}${aliasNote}`);
}
if (record.missing.length) {
  console.log('');
  console.log(`  missing explicit files: ${record.missing.join(', ')}`);
}
if (record.targets.length) {
  console.log('');
  console.log('  suggested trim targets:');
  for (const target of record.targets) console.log(`    * ${target.suggestion}`);
}
console.log('');
console.log(record.weight === 'light'
  ? '  Light. Nothing to trim.'
  : '  Review the suggested files. Use a verified trim plan before moving history.');
console.log(bar);
