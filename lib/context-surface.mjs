import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENTS = ['codex', 'claude', 'cursor'];

export const DEFAULT_CONFIG = Object.freeze({
  agents: ['auto'],
  discover: true,
  surface: [],
  thresholds: { watch: 8000, heavy: 16000 },
  perFileSoft: { '*': 4000 },
  journal: null,
});

export class DebloatConfigError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const assertStringArray = (value, name) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new DebloatConfigError(`${name} must be an array of non-empty strings`);
  }
};

const validateConfig = (config) => {
  assertStringArray(config.agents, 'agents');
  assertStringArray(config.surface, 'surface');
  if (typeof config.discover !== 'boolean') {
    throw new DebloatConfigError('discover must be a boolean');
  }
  if (!isObject(config.thresholds)) {
    throw new DebloatConfigError('thresholds must be an object');
  }
  const { watch, heavy } = config.thresholds;
  if (!Number.isFinite(watch) || !Number.isFinite(heavy) || watch <= 0 || heavy <= watch) {
    throw new DebloatConfigError('thresholds must satisfy 0 < watch < heavy');
  }
  if (!isObject(config.perFileSoft)) {
    throw new DebloatConfigError('perFileSoft must be an object');
  }
  for (const [file, limit] of Object.entries(config.perFileSoft)) {
    if (!file || !Number.isFinite(limit) || limit <= 0) {
      throw new DebloatConfigError('perFileSoft values must be positive numbers');
    }
  }
  if (config.journal !== null && (typeof config.journal !== 'string' || !config.journal.trim())) {
    throw new DebloatConfigError('journal must be null or a non-empty path');
  }
  const unknownAgents = config.agents.filter((agent) => agent !== 'auto' && agent !== 'all' && !AGENTS.includes(agent));
  if (unknownAgents.length) {
    throw new DebloatConfigError(`unknown agent: ${unknownAgents.join(', ')}`);
  }
  return config;
};

export const loadConfig = ({ root, configPath }) => {
  const resolvedPath = configPath
    ? path.resolve(root, configPath)
    : path.join(root, '.debloat.json');
  let parsed = {};
  if (fs.existsSync(resolvedPath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch (error) {
      throw new DebloatConfigError(`could not parse ${resolvedPath}: ${error.message}`);
    }
    if (!isObject(parsed)) {
      throw new DebloatConfigError(`${resolvedPath} must contain a JSON object`);
    }
  }
  return validateConfig({
    ...DEFAULT_CONFIG,
    ...parsed,
    agents: parsed.agents ?? [...DEFAULT_CONFIG.agents],
    surface: parsed.surface ?? [...DEFAULT_CONFIG.surface],
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(parsed.thresholds ?? {}) },
    perFileSoft: { ...DEFAULT_CONFIG.perFileSoft, ...(parsed.perFileSoft ?? {}) },
  });
};

const normalizeAgents = (agents) => {
  const unknownAgents = agents.filter((agent) => agent !== 'auto' && agent !== 'all' && !AGENTS.includes(agent));
  if (unknownAgents.length) throw new DebloatConfigError(`unknown agent: ${unknownAgents.join(', ')}`);
  if (agents.includes('auto') || agents.includes('all')) return [...AGENTS];
  return [...new Set(agents)];
};

const hasContent = (file) => {
  try {
    return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
};

const pathLabel = (root, absolutePath) => {
  const relative = path.relative(root, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  if (!relative) return '.';
  return absolutePath;
};

const addCandidate = (candidates, absolutePath, agent, reason) => {
  const resolved = path.resolve(absolutePath);
  const current = candidates.get(resolved) ?? { path: resolved, agents: new Set(), reasons: new Set() };
  current.agents.add(agent);
  current.reasons.add(reason);
  candidates.set(resolved, current);
};

const ancestorDirectories = (start) => {
  const directories = [];
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
};

const findGitRoot = (start) => {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
};

const readCodexFallbackNames = (codexHome) => {
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) return [];
  const match = fs.readFileSync(configPath, 'utf8').match(/^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m);
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
};

const discoverCodex = (root, candidates) => {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const globalOverride = path.join(codexHome, 'AGENTS.override.md');
  const globalDefault = path.join(codexHome, 'AGENTS.md');
  const globalFile = hasContent(globalOverride) ? globalOverride : globalDefault;
  if (hasContent(globalFile)) addCandidate(candidates, globalFile, 'codex', 'global instructions');

  const projectRoot = findGitRoot(root);
  const fallbackNames = readCodexFallbackNames(codexHome);
  const directories = ancestorDirectories(root).filter((directory) => {
    const relative = path.relative(projectRoot, directory);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  for (const directory of directories) {
    const names = ['AGENTS.override.md', 'AGENTS.md', ...fallbackNames];
    const selected = names.map((name) => path.join(directory, name)).find(hasContent);
    if (selected) addCandidate(candidates, selected, 'codex', 'project instruction chain');
  }
};

const walkFiles = (directory, extension, visited = new Set()) => {
  if (!fs.existsSync(directory)) return [];
  let realDirectory;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    return [];
  }
  if (visited.has(realDirectory)) return [];
  visited.add(realDirectory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink() && fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory()) {
      files.push(...walkFiles(entryPath, extension, visited));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(extension)) {
      files.push(entryPath);
    }
  }
  return files;
};

const frontmatter = (content) => {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('\n---', 3);
  return end === -1 ? '' : content.slice(3, end);
};

const isUnconditionalClaudeRule = (file) => !/^\s*paths\s*:/m.test(frontmatter(fs.readFileSync(file, 'utf8')));
const isAlwaysCursorRule = (file) => /^\s*alwaysApply\s*:\s*true\s*$/mi.test(frontmatter(fs.readFileSync(file, 'utf8')));

const discoverClaudeRules = (directory, candidates, reason) => {
  for (const file of walkFiles(directory, '.md')) {
    if (isUnconditionalClaudeRule(file)) addCandidate(candidates, file, 'claude', reason);
  }
};

const discoverClaude = (root, candidates) => {
  const managedFile = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
    : '/etc/claude-code/CLAUDE.md';
  if (hasContent(managedFile)) addCandidate(candidates, managedFile, 'claude', 'managed instructions');

  const claudeHome = path.join(os.homedir(), '.claude');
  const userFile = path.join(claudeHome, 'CLAUDE.md');
  if (hasContent(userFile)) addCandidate(candidates, userFile, 'claude', 'user instructions');
  discoverClaudeRules(path.join(claudeHome, 'rules'), candidates, 'unconditional user rule');

  for (const directory of ancestorDirectories(root)) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
      const file = path.join(directory, name);
      if (hasContent(file)) addCandidate(candidates, file, 'claude', 'project instruction chain');
    }
    discoverClaudeRules(path.join(directory, '.claude', 'rules'), candidates, 'unconditional project rule');
  }
};

const discoverCursor = (root, candidates) => {
  const legacy = path.join(root, '.cursorrules');
  if (hasContent(legacy)) addCandidate(candidates, legacy, 'cursor', 'legacy project rule');
  for (const file of walkFiles(path.join(root, '.cursor', 'rules'), '.mdc')) {
    if (isAlwaysCursorRule(file)) addCandidate(candidates, file, 'cursor', 'always-applied project rule');
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(root, name);
    if (hasContent(file)) addCandidate(candidates, file, 'cursor', 'Cursor CLI root rule');
  }
};

const extractClaudeImports = (file) => {
  const imports = [];
  let inFence = false;
  const content = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const visibleLine = line.replace(/`+[^`]*`+/g, '');
    for (const match of visibleLine.matchAll(/(?:^|[\s(])@((?:~\/|\.?\.?\/)?[A-Za-z0-9_.\/-]+)/g)) {
      let imported = match[1];
      if (imported.startsWith('~/')) imported = path.join(os.homedir(), imported.slice(2));
      else if (!path.isAbsolute(imported)) imported = path.resolve(path.dirname(file), imported);
      if (hasContent(imported)) imports.push(imported);
    }
  }
  return imports;
};

const expandClaudeImports = (candidates) => {
  const queue = [...candidates.values()].filter((candidate) => candidate.agents.has('claude')).map((candidate) => ({ file: candidate.path, depth: 0 }));
  const visited = new Set();
  while (queue.length) {
    const { file, depth } = queue.shift();
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    if (visited.has(real) || depth >= 5) continue;
    visited.add(real);
    for (const imported of extractClaudeImports(file)) {
      addCandidate(candidates, imported, 'claude', `imported by ${file}`);
      queue.push({ file: imported, depth: depth + 1 });
    }
  }
};

export const discoverSurface = ({ root, agents }) => {
  const candidates = new Map();
  const selectedAgents = normalizeAgents(agents);
  if (selectedAgents.includes('codex')) discoverCodex(root, candidates);
  if (selectedAgents.includes('claude')) discoverClaude(root, candidates);
  if (selectedAgents.includes('cursor')) discoverCursor(root, candidates);
  if (selectedAgents.includes('claude')) expandClaudeImports(candidates);
  return { candidates, agents: selectedAgents };
};

export const estimateTokens = (characters) => Math.max(characters > 0 ? 1 : 0, Math.round(characters / 4));

const softLimitFor = (aliases, perFileSoft) => {
  for (const alias of aliases) {
    if (perFileSoft[alias] !== undefined) return perFileSoft[alias];
  }
  return perFileSoft['*'] ?? null;
};

export const measureSurface = ({ root, config, includes = [], cliAgents = [], discover = config.discover }) => {
  const selectedAgents = cliAgents.length ? cliAgents : config.agents;
  const { candidates, agents } = discover
    ? discoverSurface({ root, agents: selectedAgents })
    : { candidates: new Map(), agents: [] };
  const explicitPaths = [...config.surface, ...includes];
  const missing = [];
  for (const entry of explicitPaths) {
    const absolutePath = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
    if (!hasContent(absolutePath)) {
      missing.push(entry);
      continue;
    }
    addCandidate(candidates, absolutePath, 'custom', 'explicit surface');
  }

  const byRealPath = new Map();
  for (const candidate of candidates.values()) {
    if (!hasContent(candidate.path)) continue;
    const realPath = fs.realpathSync(candidate.path);
    const alias = pathLabel(root, candidate.path);
    const current = byRealPath.get(realPath) ?? {
      realPath,
      aliases: new Set(),
      agents: new Set(),
      reasons: new Set(),
    };
    current.aliases.add(alias);
    for (const agent of candidate.agents) current.agents.add(agent);
    for (const reason of candidate.reasons) current.reasons.add(reason);
    byRealPath.set(realPath, current);
  }

  const files = [...byRealPath.values()].map((entry) => {
    const content = fs.readFileSync(entry.realPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const characters = [...content].length;
    const estimatedTokens = estimateTokens(characters);
    const aliases = [...entry.aliases].sort();
    const soft = softLimitFor(aliases, config.perFileSoft);
    return {
      file: aliases[0],
      aliases,
      realpath: entry.realPath,
      agents: [...entry.agents].sort(),
      reasons: [...entry.reasons].sort(),
      bytes,
      characters,
      estimated_tokens: estimatedTokens,
      tok: estimatedTokens,
      soft,
      heavy: soft !== null && estimatedTokens > soft,
    };
  }).sort((left, right) => right.estimated_tokens - left.estimated_tokens || left.file.localeCompare(right.file));

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const totalCharacters = files.reduce((sum, file) => sum + file.characters, 0);
  const totalTokens = files.reduce((sum, file) => sum + file.estimated_tokens, 0);
  const targets = files.filter((file) => file.heavy).map((file) => ({
    kind: 'file_heavy',
    file: file.file,
    tok: file.estimated_tokens,
    soft: file.soft,
    suggestion: `${file.file} is ~${file.estimated_tokens} tokens (soft ${file.soft}). Move accreted history to a history file and keep current state plus a pointer.`,
  }));
  if (!targets.length && files.length && totalTokens >= config.thresholds.watch) {
    const biggest = files[0];
    targets.push({
      kind: 'file_largest',
      file: biggest.file,
      tok: biggest.estimated_tokens,
      soft: biggest.soft,
      suggestion: `${biggest.file} is the heaviest at ~${biggest.estimated_tokens} tokens. If it carries accreted history, extract it to a history file.`,
    });
  }
  const weight = totalTokens >= config.thresholds.heavy
    ? 'heavy'
    : totalTokens >= config.thresholds.watch || targets.length ? 'watch' : 'light';

  return {
    ts: new Date().toISOString(),
    root,
    agents,
    estimate: { method: 'unicode_characters/4', label: 'ESTIMATED~' },
    total_tok: totalTokens,
    total_tokens_estimate: totalTokens,
    total_characters: totalCharacters,
    total_bytes: totalBytes,
    ref: { ...config.thresholds },
    weight,
    files,
    missing,
    targets,
  };
};
