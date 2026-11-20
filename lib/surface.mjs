// lib/surface.mjs - discover and measure an agent's always-load context surface.
//
// Discovery finds the instruction and rule files Claude Code, Codex and Cursor read on every
// session start. Measurement counts each real file once (symlinks are de-duplicated by real path)
// and reports UTF-8 bytes, Unicode characters and an estimated token count (chars/4) separately.
//
// Nothing here throws on bad input: problems become entries in `warnings` and measurement carries
// on with what it has. Read-only. Node 18+ (no dependencies).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENTS = ['claude', 'codex', 'cursor'];

export const DEFAULTS = Object.freeze({
  agents: ['auto'],
  surface: null,     // null = not declared
  discover: null,    // null = on unless "surface" is declared
  thresholds: Object.freeze({ watch: 8000, heavy: 16000 }),
  perFileSoft: Object.freeze({ '*': 4000 }),
  journal: null,
});

// v1.0 measured these two when nothing else was declared. Still the fallback with discovery off.
const LEGACY_SURFACE = ['CLAUDE.md', 'AGENTS.md'];
const IMPORT_MAX_DEPTH = 5; // Claude Code follows @imports five hops deep

export const estimateTokens = (chars) => Math.round(chars / 4); // deterministic estimate, not a tokenizer

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isInside = (dir, p) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// ---- config ------------------------------------------------------------------------------
// Invalid keys are reported and replaced by their defaults. A broken config never stops a run.
export function loadConfig({ root, configPath = null } = {}) {
  const warnings = [];
  const cfg = {
    ...DEFAULTS, agents: [...DEFAULTS.agents],
    thresholds: { ...DEFAULTS.thresholds }, perFileSoft: { ...DEFAULTS.perFileSoft },
  };
  const file = configPath ? path.resolve(root, configPath) : path.join(root, '.debloat.json');
  if (!fs.existsSync(file)) {
    if (configPath) warnings.push(`config not found: ${file}`);
    return { config: cfg, warnings };
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push(`could not parse ${file}: ${e.message}`); return { config: cfg, warnings }; }
  if (!isObject(parsed)) { warnings.push(`${file} must contain a JSON object`); return { config: cfg, warnings }; }

  const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim());
  if (parsed.surface !== undefined) {
    if (strings(parsed.surface)) cfg.surface = parsed.surface;
    else warnings.push('config "surface" must be an array of paths; ignored');
  }
  if (parsed.agents !== undefined) {
    const list = typeof parsed.agents === 'string' ? [parsed.agents] : parsed.agents;
    if (strings(list)) cfg.agents = list;
    else warnings.push('config "agents" must be an array of agent names; ignored');
  }
  if (parsed.discover !== undefined) {
    if (typeof parsed.discover === 'boolean') cfg.discover = parsed.discover;
    else warnings.push('config "discover" must be true or false; ignored');
  }
  if (parsed.thresholds !== undefined) {
    const t = isObject(parsed.thresholds) ? { ...DEFAULTS.thresholds, ...parsed.thresholds } : null;
    if (t && isPositive(t.watch) && isPositive(t.heavy) && t.watch < t.heavy) cfg.thresholds = { watch: t.watch, heavy: t.heavy };
    else warnings.push('config "thresholds" must satisfy 0 < watch < heavy; using defaults');
  }
  if (parsed.perFileSoft !== undefined) {
    if (isObject(parsed.perFileSoft)) {
      // A declared perFileSoft replaces the default wholesale: add "*" yourself for a fallback.
      cfg.perFileSoft = {};
      for (const [key, limit] of Object.entries(parsed.perFileSoft)) {
        if (isPositive(limit)) cfg.perFileSoft[key] = limit;
        else warnings.push(`config "perFileSoft" entry "${key}" must be a positive number; ignored`);
      }
    } else warnings.push('config "perFileSoft" must be an object; using defaults');
  }
  if (parsed.journal !== undefined && parsed.journal !== null) {
    if (typeof parsed.journal === 'string' && parsed.journal.trim()) cfg.journal = parsed.journal;
    else warnings.push('config "journal" must be a path; ignored');
  }
  return { config: cfg, warnings };
}

// "auto" and "all" mean every supported agent. Unknown names are reported and dropped.
export function resolveAgents(names, warnings = []) {
  const out = new Set();
  for (const raw of names) {
    const name = String(raw).toLowerCase();
    if (name === 'auto' || name === 'all') AGENTS.forEach((a) => out.add(a));
    else if (AGENTS.includes(name)) out.add(name);
    else warnings.push(`unknown agent "${raw}" (expected ${AGENTS.join(', ')}, auto or all); ignored`);
  }
  return AGENTS.filter((a) => out.has(a));
}

// ---- filesystem helpers ------------------------------------------------------------------
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const hasContent = (p) => isFile(p) && readText(p).trim().length > 0;

function ancestors(start) { // outermost first, `start` last
  const out = [];
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    out.unshift(dir);
    if (dir === path.dirname(dir)) return out;
  }
}

function gitRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (dir === path.dirname(dir)) return null;
  }
}

// Recursive listing by extension. Follows directory symlinks, guards against loops by real path.
function walk(dir, ext, seen = new Set()) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return []; }
  if (seen.has(real)) return [];
  seen.add(real);
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; } // dangling symlink
    if (st.isDirectory()) out.push(...walk(full, ext, seen));
    else if (st.isFile() && name.endsWith(ext)) out.push(full);
  }
  return out;
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''));
  return m ? m[1] : '';
}

// ---- discovery ---------------------------------------------------------------------------
// Each finder calls add(absPath, agent, why). Only files loaded unconditionally are added.

function findClaude({ root, home, env, platform, managedFile }, add) {
  const managed = managedFile !== undefined ? managedFile
    : platform === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
    : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\CLAUDE.md'
    : '/etc/claude-code/CLAUDE.md';
  if (managed && hasContent(managed)) add(managed, 'claude', 'managed memory');

  // A rule with a `paths:` frontmatter key loads only for matching files, so it is not always-load.
  const rules = (dir, why) => {
    for (const f of walk(dir, '.md')) if (!/^\s*paths\s*:/m.test(frontmatter(readText(f)))) add(f, 'claude', why);
  };
  const userDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  if (hasContent(path.join(userDir, 'CLAUDE.md'))) add(path.join(userDir, 'CLAUDE.md'), 'claude', 'user memory');
  rules(path.join(userDir, 'rules'), 'user rule');

  for (const dir of ancestors(root)) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      if (hasContent(path.join(dir, name))) add(path.join(dir, name), 'claude', 'project memory');
    }
    rules(path.join(dir, '.claude', 'rules'), 'project rule');
  }
}

// `@path` imports in a Claude memory file, skipping code fences, code spans and HTML comments.
function claudeImports(file, home) {
  const out = [];
  let fenced = false;
  for (const line of readText(file).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|[\s(])@([^\s()`'"<>]+)/g)) {
      // try the reference as written, then without trailing sentence punctuation
      for (const ref of new Set([m[1], m[1].replace(/[.,;:!?]+$/, '')])) {
        if (!ref) continue;
        const abs = ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.resolve(path.dirname(file), ref);
        if (isFile(abs)) { out.push(abs); break; }
      }
    }
  }
  return out;
}

function findCodex({ root, home, env }, add) {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  // global: the override wins over AGENTS.md; the first non-empty one is the only one read
  const global = ['AGENTS.override.md', 'AGENTS.md'].map((n) => path.join(codexHome, n)).find(hasContent);
  if (global) add(global, 'codex', 'global instructions');

  let fallbacks = [];
  const m = /^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m.exec(readText(path.join(codexHome, 'config.toml')));
  if (m) fallbacks = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);

  // project: one file per directory from the git root down to the working directory
  const top = gitRoot(root) ?? root;
  for (const dir of ancestors(root).filter((d) => isInside(top, d))) {
    const pick = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks].map((n) => path.join(dir, n)).find(hasContent);
    if (pick) add(pick, 'codex', 'project instructions');
  }
}

function findCursor({ root }, add) {
  if (hasContent(path.join(root, '.cursorrules'))) add(path.join(root, '.cursorrules'), 'cursor', 'legacy rules file');
  for (const f of walk(path.join(root, '.cursor', 'rules'), '.mdc')) {
    if (/^\s*alwaysApply\s*:\s*true\s*$/mi.test(frontmatter(readText(f)))) add(f, 'cursor', 'always-apply rule');
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) { // read at the project root, the latter by the Cursor CLI
    if (hasContent(path.join(root, name))) add(path.join(root, name), 'cursor', 'root instructions');
  }
}

export function discover({ root, agents, home = os.homedir(), env = process.env, platform = process.platform, managedFile, warnings = [] }) {
  const found = new Map(); // absolute path -> { path, agents:Set, why:Set }
  const add = (p, agent, why) => {
    const abs = path.resolve(p);
    const cur = found.get(abs) ?? { path: abs, agents: new Set(), why: new Set(), declared: false };
    cur.agents.add(agent); cur.why.add(why);
    found.set(abs, cur);
  };
  const ctx = { root, home, env, platform, managedFile };
  const finders = { claude: findClaude, codex: findCodex, cursor: findCursor };
  for (const agent of agents) {
    try { finders[agent](ctx, add); }
    catch (e) { warnings.push(`${agent} discovery failed: ${e.message}`); }
  }
  if (agents.includes('claude')) {
    const queue = [...found.values()].filter((c) => c.agents.has('claude')).map((c) => ({ file: c.path, depth: 0 }));
    const seen = new Set();
    while (queue.length) {
      const { file, depth } = queue.shift();
      let real;
      try { real = fs.realpathSync(file); } catch { continue; }
      if (seen.has(real) || depth >= IMPORT_MAX_DEPTH) continue;
      seen.add(real);
      for (const imp of claudeImports(file, home)) {
        add(imp, 'claude', 'imported');
        queue.push({ file: imp, depth: depth + 1 });
      }
    }
  }
  return found;
}

// ---- measurement -------------------------------------------------------------------------
export function measure({
  root, config, includes = [], agents: cliAgents = [], noDiscover = false,
  home = os.homedir(), env = process.env, platform = process.platform, managedFile, warnings = [],
}) {
  try { home = fs.realpathSync(home); } catch { /* keep as given */ }
  // Discovery is on by default. A declared "surface" is taken as the whole surface (the v1.0
  // behavior) unless "discover": true or --agent asks for discovery on top of it.
  const discovering = !noDiscover && (cliAgents.length > 0 || (config.discover ?? config.surface === null));
  const agents = discovering ? resolveAgents(cliAgents.length ? cliAgents : config.agents, warnings) : [];
  const found = discovering ? discover({ root, agents, home, env, platform, managedFile, warnings }) : new Map();

  const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : path.resolve(root, p));
  const declared = [...(config.surface ?? (discovering ? [] : LEGACY_SURFACE)), ...includes];
  const missing = [];
  for (const entry of new Set(declared)) {
    const abs = expand(entry);
    if (!isFile(abs)) { if (config.surface?.includes(entry) || includes.includes(entry)) missing.push(entry); continue; }
    const cur = found.get(abs) ?? { path: abs, agents: new Set(), why: new Set(), declared: false };
    cur.declared = true; cur.why.add('declared');
    found.set(abs, cur);
  }

  const label = (abs) => {
    if (isInside(root, abs) && abs !== root) return path.relative(root, abs).split(path.sep).join('/');
    if (isInside(home, abs) && abs !== home) return '~/' + path.relative(home, abs).split(path.sep).join('/');
    return abs;
  };

  // de-duplicate by real path: a file reached through three symlinks is still loaded content once
  const byReal = new Map();
  for (const c of found.values()) {
    let real;
    try { real = fs.realpathSync(c.path); } catch { continue; }
    const cur = byReal.get(real) ?? { real, paths: new Set(), agents: new Set(), why: new Set(), declared: false };
    cur.paths.add(c.path);
    c.agents.forEach((a) => cur.agents.add(a));
    c.why.forEach((w) => cur.why.add(w));
    cur.declared ||= c.declared;
    byReal.set(real, cur);
  }

  // perFileSoft keys are paths (matched by real path, so any alias works); "*" is the fallback
  const softByReal = new Map();
  for (const [key, limit] of Object.entries(config.perFileSoft)) {
    if (key === '*') continue;
    try { softByReal.set(fs.realpathSync(expand(key)), limit); } catch { /* file absent: nothing to flag */ }
  }

  const files = [];
  for (const e of byReal.values()) {
    let buf;
    try { buf = fs.readFileSync(e.real); } catch (err) { warnings.push(`could not read ${label(e.real)}: ${err.message}`); continue; }
    let chars = 0;
    for (const _ of buf.toString('utf8')) chars++; // code points, not UTF-16 units
    const names = [...e.paths].map(label).sort((a, b) => path.isAbsolute(a) - path.isAbsolute(b) || a.startsWith('~') - b.startsWith('~') || a.length - b.length || a.localeCompare(b));
    const tok = estimateTokens(chars);
    const soft = softByReal.get(e.real) ?? config.perFileSoft['*'] ?? null;
    const file = { file: names[0], tok, chars, bytes: buf.length, soft, heavy: soft != null && tok > soft,
      agents: AGENTS.filter((a) => e.agents.has(a)), why: [...e.why].sort(), aliases: names.slice(1), declared: e.declared };
    if (!e.paths.has(e.real)) file.real = label(e.real); // reached only through a symlink
    files.push(file);
  }
  files.sort((a, b) => b.tok - a.tok || a.file.localeCompare(b.file));

  const sum = (list, key) => list.reduce((n, f) => n + f[key], 0);
  const totalChars = sum(files, 'chars'), totalBytes = sum(files, 'bytes'), totalTok = estimateTokens(totalChars);
  const { watch, heavy } = config.thresholds;

  // suggested trim targets (informational)
  const targets = files.filter((f) => f.heavy).map((f) => ({ file: f.file, kind: 'file_heavy', tok: f.tok, soft: f.soft,
    suggestion: `${f.file} is ${f.tok} tok (soft ${f.soft}). Move accreted history to a *-history file; keep current state + a pointer.` }));
  if (!targets.length && files.length && totalTok >= watch) {
    const big = files[0];
    targets.push({ file: big.file, kind: 'file_largest', tok: big.tok, soft: big.soft,
      suggestion: `${big.file} is the heaviest at ${big.tok} tok. If it carries accreted history, extract it to a *-history file.` });
  }

  // weight label (informational, never blocks)
  let weight = 'light';
  if (totalTok >= heavy) weight = 'heavy';
  else if (totalTok >= watch || targets.length) weight = 'watch';

  // what each agent loads on its own: its discovered files plus everything declared
  const byAgent = {};
  for (const a of agents) {
    const mine = files.filter((f) => f.declared || f.agents.includes(a));
    byAgent[a] = { tok: estimateTokens(sum(mine, 'chars')), chars: sum(mine, 'chars'), bytes: sum(mine, 'bytes'), files: mine.length };
  }

  return {
    ts: new Date().toISOString(), root, agents,
    total_tok: totalTok, total_chars: totalChars, total_bytes: totalBytes,
    estimate: { method: 'chars/4', exact: false },
    ref: { watch, heavy }, weight, by_agent: byAgent,
    files, targets, missing, warnings,
  };
}
