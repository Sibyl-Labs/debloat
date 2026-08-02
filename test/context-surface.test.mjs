import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CONFIG,
  DebloatConfigError,
  loadConfig,
  measureSurface,
} from '../lib/context-surface.mjs';

const temporaryRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-context-'));
const config = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  agents: [],
  discover: false,
  surface: [],
  thresholds: { ...DEFAULT_CONFIG.thresholds },
  perFileSoft: { ...DEFAULT_CONFIG.perFileSoft },
  ...overrides,
});

test('measures UTF-8 bytes, Unicode characters, and estimated tokens separately', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = 'ASCII, café, 😀\n';
  fs.writeFileSync(path.join(root, 'instructions.md'), content);

  const report = measureSurface({
    root,
    config: config({ surface: ['instructions.md'] }),
  });

  assert.equal(report.files.length, 1);
  assert.equal(report.total_bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(report.total_characters, [...content].length);
  assert.equal(report.total_tokens_estimate, Math.round([...content].length / 4));
  assert.equal(report.estimate.method, 'unicode_characters/4');
});

test('counts symlink aliases only once by real path', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'shared instructions\n');
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));

  const report = measureSurface({
    root,
    config: config({ surface: ['AGENTS.md', 'CLAUDE.md'] }),
  });

  assert.equal(report.files.length, 1);
  assert.deepEqual(report.files[0].aliases, ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(report.total_bytes, Buffer.byteLength('shared instructions\n'));
});

test('discovers always-loaded files for Codex, Claude Code, and Cursor', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Codex instructions\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Claude instructions\n');
  fs.writeFileSync(path.join(root, '.claude', 'rules', 'always.md'), '# Always\n');
  fs.writeFileSync(path.join(root, '.claude', 'rules', 'conditional.md'), '---\npaths:\n  - src/**\n---\nConditional\n');
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nAlways\n');
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'conditional.mdc'), '---\nalwaysApply: false\n---\nConditional\n');

  const report = measureSurface({
    root,
    config: config({ agents: ['codex', 'claude', 'cursor'], discover: true }),
  });
  const localFiles = new Set(report.files.map((file) => file.file).filter((file) => !path.isAbsolute(file)));

  assert(localFiles.has('AGENTS.md'));
  assert(localFiles.has('CLAUDE.md'));
  assert(localFiles.has('.claude/rules/always.md'));
  assert(localFiles.has('.cursor/rules/always.mdc'));
  assert(!localFiles.has('.claude/rules/conditional.md'));
  assert(!localFiles.has('.cursor/rules/conditional.mdc'));
});

test('rejects invalid configuration instead of silently falling back', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.debloat.json'), '{ invalid json');

  assert.throws(
    () => loadConfig({ root }),
    (error) => error instanceof DebloatConfigError && /could not parse/.test(error.message),
  );
});

test('reports missing explicit files without failing measurement', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = measureSurface({
    root,
    config: config({ surface: ['missing.md'] }),
  });

  assert.deepEqual(report.missing, ['missing.md']);
  assert.equal(report.files.length, 0);
  assert.equal(report.weight, 'light');
});

test('discovers Claude imports but ignores imports shown in code or comments', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'included.md'), 'Included instructions.\n');
  fs.writeFileSync(path.join(root, 'inline.md'), 'Inline example.\n');
  fs.writeFileSync(path.join(root, 'fenced.md'), 'Fenced example.\n');
  fs.writeFileSync(path.join(root, 'commented.md'), 'Commented example.\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), [
    '@included.md',
    '`@inline.md`',
    '```md',
    '@fenced.md',
    '```',
    '<!-- @commented.md -->',
  ].join('\n'));

  const report = measureSurface({
    root,
    config: config({ agents: ['claude'], discover: true }),
  });
  const localFiles = new Set(report.files.map((file) => file.file).filter((file) => !path.isAbsolute(file)));

  assert(localFiles.has('included.md'));
  assert(!localFiles.has('inline.md'));
  assert(!localFiles.has('fenced.md'));
  assert(!localFiles.has('commented.md'));
});
