#!/usr/bin/env node
// context-hygiene.mjs - deterministic measurement of an AI agent's always-load context surface.
//
// "debloat" measures what your agent loads on EVERY session start (its instruction files, rules,
// and any always-read state files) and reports the weight plus the heaviest files, so you can keep
// the always-load surface light. Pure arithmetic, no LLM judgment, so the number cannot be
// rationalized away. It reports UTF-8 bytes, Unicode characters and estimated tokens separately;
// the token figure is chars/4, labelled ESTIMATE~, not an exact tokenizer count.
//
// Environment hygiene, not a gate: it never blocks a session and never forces a trim. You decide.
//
// Modes:
//   --fyi     one quiet line (weight + heavy spots). Good for a session-start hook.
//   --json    machine-readable record (drives an interactive trim pass).
//   (default) full human report: file weights + suggested trim targets.
//
// Surface: discovered for Claude Code, Codex and Cursor (--agent <name>, repeatable; default all
// three), plus anything you declare. A "surface" list in the config is taken as the whole surface
// unless "discover": true or --agent is given. --no-discover measures declared files only.
//
// Config (optional): a .debloat.json in the root, or --config <path>:
//   { "agents": ["claude"],
//     "surface": ["docs/always-loaded-state.md"], "discover": true,
//     "thresholds": { "watch": 8000, "heavy": 16000 },
//     "perFileSoft": { "*": 4000, "CLAUDE.md": 6000 },
//     "journal": ".debloat/history.jsonl" }
// You can also list files on the CLI with --include <path> (repeatable).
//
// Always exits 0. Problems are warnings on stderr. Node 18+ (no dependencies).
// Usage: node context-hygiene.mjs [--fyi|--json] [--root <dir>] [--config <path>]
//          [--agent <claude|codex|cursor|all>]... [--include <path>]... [--no-discover]

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, measure } from './lib/surface.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const opts = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n && args[i + 1]) out.push(args[i + 1]); return out; };

if (flag('--help') || flag('-h')) {
  console.log(`Usage: node context-hygiene.mjs [options]

  --fyi              one summary line (for a session-start hook)
  --json             machine-readable record
  --root <dir>       project root to inspect (default: current directory)
  --config <path>    config file (default: <root>/.debloat.json)
  --agent <name>     claude, codex, cursor or all (repeatable; default: all)
  --include <path>   add a file to the measured surface (repeatable)
  --no-discover      measure only declared and included files

Always exits 0. To move history out of a heavy file, see trim-context.mjs.`);
  process.exit(0);
}

let ROOT = path.resolve(opt('--root', process.cwd()));
try { ROOT = fs.realpathSync(ROOT); } catch { /* a missing root measures as empty */ }

const { config: CFG, warnings } = loadConfig({ root: ROOT, configPath: opt('--config', null) });

// ---- MEASURE (deterministic) -------------------------------------------------------------
let record;
try {
  record = measure({ root: ROOT, config: CFG, includes: opts('--include'), agents: opts('--agent'), noDiscover: flag('--no-discover'), warnings });
} catch (e) { // never a gate: report and leave quietly
  console.error(`debloat: measurement failed: ${e.message}`);
  process.exit(0);
}
for (const w of record.warnings) console.error(`debloat: ${w}`);
const { files, targets, weight, total_tok: totalTok } = record;
const WATCH = record.ref.watch, HEAVY = record.ref.heavy;

// ---- OBSERVE: optional append-only telemetry (best-effort, never throws) ------------------
// The journal must resolve inside the root, so a config cannot make a hook write elsewhere.
if (CFG.journal) {
  try {
    const inside = (p) => { const rel = path.relative(ROOT, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
    const jp = path.resolve(ROOT, CFG.journal);
    let anchor = jp; // nearest existing path, resolved through any symlinks
    while (!fs.existsSync(anchor) && anchor !== path.dirname(anchor)) anchor = path.dirname(anchor);
    if (!inside(jp) || !inside(fs.realpathSync(anchor))) throw new Error('journal path must stay inside the root');
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    fs.appendFileSync(jp, JSON.stringify({ ts: record.ts, total_tok: totalTok, total_chars: record.total_chars, total_bytes: record.total_bytes, weight, targets: targets.length }) + '\n');
  } catch (e) { console.error(`debloat: journal skipped: ${e.message}`); }
}

// ---- OUTPUT ------------------------------------------------------------------------------
if (flag('--json')) {
  const out = { ...record, files: files.map(({ declared, ...f }) => f) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (flag('--fyi')) {
  const heavyList = files.filter((f) => f.heavy).map((f) => `${f.file.split('/').pop()} ${f.tok}t`);
  const spots = heavyList.length ? ` | heavy: ${heavyList.join(', ')}` : '';
  const hint = weight === 'light' ? '' : ' - /debloat to trim';
  console.log(`context: ~${(totalTok / 1000).toFixed(1)}k tok always-load (${weight})${spots}${hint}`);
  process.exit(0);
}

const bar = '='.repeat(60);
const n = (v) => v.toLocaleString('en-US');
console.log(bar);
console.log(`CONTEXT WEIGHT  ${record.ts}`);
console.log(bar);
if (!files.length) {
  console.log('  no always-load files found.');
  if (record.agents.length) console.log(`  discovery ran for: ${record.agents.join(', ')}`);
  if (record.missing.length) console.log(`  declared but missing: ${record.missing.join(', ')}`);
  console.log('  set "surface" in .debloat.json or pass --include <file>.');
  console.log(bar);
  process.exit(0);
}
console.log(`  always-load surface: ${n(totalTok)} tok   [ESTIMATE~ chars/4]`);
console.log(`  measured: ${n(record.total_chars)} chars / ${n(record.total_bytes)} bytes in ${files.length} file${files.length === 1 ? '' : 's'}`);
console.log(`  reference: light <${WATCH / 1000}k / watch <${HEAVY / 1000}k / heavy >=${HEAVY / 1000}k`);
console.log(`  weight: ${weight}`);
if (record.agents.length > 1) {
  console.log('');
  console.log('  per agent (a file shared by several agents counts once in the total):');
  for (const a of record.agents) console.log(`    ${String(record.by_agent[a].tok).padStart(6)} tok  ${a} (${record.by_agent[a].files} file${record.by_agent[a].files === 1 ? '' : 's'})`);
} else if (record.agents.length) {
  console.log(`  agent: ${record.agents[0]}`);
}
console.log('');
console.log('  file weights (heaviest first):');
for (const f of files) {
  const mark = f.heavy ? '  <-- heavy (soft ' + f.soft + ')' : (f.soft ? '  (soft ' + f.soft + ')' : '');
  const also = [...f.aliases, ...(f.real ? [`-> ${f.real}`] : [])];
  console.log(`    ${String(f.tok).padStart(6)} tok  ${String(f.chars).padStart(7)} ch  ${String(f.bytes).padStart(7)} B  ${f.file}${mark}`);
  if (also.length) console.log(`${' '.repeat(39)}same file: ${also.join(', ')}`);
}
if (record.missing.length) {
  console.log('');
  console.log(`  declared but missing: ${record.missing.join(', ')}`);
}
if (targets.length) {
  console.log('');
  console.log('  suggested trim targets (you choose what moves):');
  for (const t of targets) console.log(`    * ${t.suggestion}`);
}
console.log('');
console.log(weight === 'light'
  ? '  Light. Nothing to do.'
  : '  Trim: move accreted history out of the heavy files into *-history files, keep current state + a pointer.');
console.log(bar);
process.exit(0);
