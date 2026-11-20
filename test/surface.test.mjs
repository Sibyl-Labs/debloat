// Discovery and measurement. Every test runs in a temp dir with a fake home; nothing real is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, loadConfig, measure } from '../lib/surface.mjs';

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-surface-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // bounds the Codex project walk
  fs.mkdirSync(home);
  const write = (dir, rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const run = (opts = {}) => {
    const { config, warnings } = loadConfig({ root });
    return measure({ root, config, home, env: {}, managedFile: null, warnings, ...opts });
  };
  return { base, root, home, write, run };
}
const names = (record) => record.files.map((f) => f.file).sort();
const byName = (record, name) => record.files.find((f) => f.file === name);

test('reports bytes, characters and estimated tokens as three separate numbers', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'héllo wörld 日本語 🙂\n'); // 18 code points, 29 bytes
  const r = s.run({ agents: ['codex'] });
  const f = byName(r, 'AGENTS.md');
  assert.equal(f.chars, 18);
  assert.equal(f.bytes, 29);
  assert.equal(f.tok, 5); // round(18 / 4): characters, not bytes
  assert.deepEqual([r.total_tok, r.total_chars, r.total_bytes], [5, 18, 29]);
  assert.deepEqual(r.estimate, { method: 'chars/4', exact: false });
});

test('defaults are 8k watch, 16k heavy and a 4k per-file soft ceiling', (t) => {
  const s = sandbox(t);
  assert.deepEqual(DEFAULTS.thresholds, { watch: 8000, heavy: 16000 });
  s.write(s.root, 'AGENTS.md', 'x'.repeat(4001 * 4));
  const r = s.run({ agents: ['codex'] });
  assert.deepEqual(r.ref, { watch: 8000, heavy: 16000 });
  assert.equal(byName(r, 'AGENTS.md').soft, 4000);
  assert.equal(byName(r, 'AGENTS.md').heavy, true);
  assert.equal(r.weight, 'watch'); // under the total threshold, but a heavy file is present
  assert.equal(r.targets[0].kind, 'file_heavy');
});

test('weight follows configured thresholds', (t) => {
  const s = sandbox(t);
  s.write(s.root, '.debloat.json', JSON.stringify({ thresholds: { watch: 10, heavy: 20 }, perFileSoft: {} }));
  s.write(s.root, 'AGENTS.md', 'x'.repeat(36)); // 9 tok
  assert.equal(s.run({ agents: ['codex'] }).weight, 'light');
  s.write(s.root, 'AGENTS.md', 'x'.repeat(40)); // 10 tok
  const watch = s.run({ agents: ['codex'] });
  assert.equal(watch.weight, 'watch');
  assert.equal(watch.targets[0].kind, 'file_largest');
  s.write(s.root, 'AGENTS.md', 'x'.repeat(80)); // 20 tok
  assert.equal(s.run({ agents: ['codex'] }).weight, 'heavy');
});

test('a file reached through several symlinks is counted once', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'shared instructions\n');
  fs.symlinkSync('AGENTS.md', path.join(s.root, 'CLAUDE.md'));
  fs.symlinkSync('AGENTS.md', path.join(s.root, '.cursorrules'));
  const r = s.run({ agents: ['all'] });
  const inRoot = r.files.filter((f) => !path.isAbsolute(f.file) && !f.file.startsWith('~'));
  assert.equal(inRoot.length, 1);
  assert.deepEqual([inRoot[0].file, ...inRoot[0].aliases].sort(), ['.cursorrules', 'AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(inRoot[0].agents, ['claude', 'codex', 'cursor']);
  assert.equal(inRoot[0].bytes, 20);
  // each agent still loads it, so it shows in every per-agent subtotal
  for (const a of ['claude', 'codex', 'cursor']) assert.ok(r.by_agent[a].bytes >= 20);
});

test('Claude Code: user and project memory, unconditional rules, and imports', (t) => {
  const s = sandbox(t);
  s.write(s.home, '.claude/CLAUDE.md', 'user memory\n');
  s.write(s.home, '.claude/rules/style.md', 'always\n');
  s.write(s.home, '.claude/rules/scoped.md', '---\npaths:\n  - "src/**"\n---\nonly for src\n');
  s.write(s.root, 'CLAUDE.md', [
    'project memory',
    'See @docs/guide.md and @~/notes.md.',
    'Not an import: `@docs/in-span.md`',
    '```',
    '@docs/in-fence.md',
    '```',
    '<!-- @docs/in-comment.md -->',
    'mention of @someone is not a file',
  ].join('\n'));
  s.write(s.root, 'CLAUDE.local.md', 'local\n');
  s.write(s.root, '.claude/CLAUDE.md', 'nested\n');
  s.write(s.root, '.claude/rules/nested/deep.md', 'deep rule\n');
  s.write(s.root, '.claude/rules/api.md', '---\npaths: ["api/**"]\n---\nconditional\n');
  s.write(s.root, 'docs/guide.md', 'guide, which imports @more.md\n');
  s.write(s.root, 'docs/more.md', 'second hop\n');
  for (const n of ['in-span', 'in-fence', 'in-comment']) s.write(s.root, `docs/${n}.md`, 'should not load\n');
  s.write(s.home, 'notes.md', 'home notes\n');
  s.write(s.root, 'AGENTS.md', 'codex only\n');

  const got = names(s.run({ agents: ['claude'] }));
  for (const want of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules/nested/deep.md',
    'docs/guide.md', 'docs/more.md', '~/.claude/CLAUDE.md', '~/.claude/rules/style.md', '~/notes.md']) {
    assert.ok(got.includes(want), `expected ${want} in ${got.join(', ')}`);
  }
  for (const not of ['.claude/rules/api.md', '~/.claude/rules/scoped.md', 'docs/in-span.md', 'docs/in-fence.md', 'docs/in-comment.md', 'AGENTS.md']) {
    assert.ok(!got.includes(not), `did not expect ${not}`);
  }
});

test('Claude Code: import chains stop after five hops and survive cycles', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'CLAUDE.md', '@h1.md\n');
  for (let i = 1; i <= 7; i++) s.write(s.root, `h${i}.md`, `@h${i + 1}.md\n`);
  s.write(s.root, 'h8.md', '@CLAUDE.md\n');
  const got = names(s.run({ agents: ['claude'] }));
  assert.ok(got.includes('h5.md'));
  assert.ok(!got.includes('h6.md'));
});

test('Claude Code: a home AGENTS.md loaded through symlinks is found and counted once', (t) => {
  const s = sandbox(t);
  s.write(s.home, 'AGENTS.md', 'one set of instructions for every agent\n');
  fs.mkdirSync(path.join(s.home, '.claude', 'rules'), { recursive: true });
  fs.symlinkSync(path.join(s.home, 'AGENTS.md'), path.join(s.home, '.claude', 'CLAUDE.md'));
  fs.symlinkSync(path.join(s.home, 'AGENTS.md'), path.join(s.home, '.claude', 'rules', 'agents.md'));
  fs.symlinkSync(path.join(s.home, 'AGENTS.md'), path.join(s.root, 'CLAUDE.md'));
  const r = s.run({ agents: ['claude'] });
  const hits = r.files.filter((f) => f.real === '~/AGENTS.md');
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].file, ...hits[0].aliases].sort(), ['CLAUDE.md', '~/.claude/CLAUDE.md', '~/.claude/rules/agents.md']);
  assert.equal(hits[0].bytes, 40);
});

test('Claude Code: a symlinked config directory and CLAUDE_CONFIG_DIR are followed', (t) => {
  const s = sandbox(t);
  s.write(s.home, 'dotfiles/claude/CLAUDE.md', 'from dotfiles\n');
  s.write(s.home, 'dotfiles/claude/rules/r.md', 'rule\n');
  fs.symlinkSync(path.join(s.home, 'dotfiles', 'claude'), path.join(s.home, '.claude'));
  const linked = s.run({ agents: ['claude'] });
  assert.ok(linked.files.some((f) => f.file === '~/.claude/CLAUDE.md' && f.real === '~/dotfiles/claude/CLAUDE.md'));
  assert.ok(linked.files.some((f) => f.file === '~/.claude/rules/r.md'));

  s.write(s.base, 'elsewhere/CLAUDE.md', 'relocated\n');
  const moved = s.run({ agents: ['claude'], env: { CLAUDE_CONFIG_DIR: path.join(s.base, 'elsewhere') } });
  assert.ok(moved.files.some((f) => f.file === path.join(s.base, 'elsewhere', 'CLAUDE.md')));
  assert.ok(!moved.files.some((f) => f.file === '~/.claude/CLAUDE.md'));
});

test('Codex: global override, one file per directory from the git root down, fallback names', (t) => {
  const s = sandbox(t);
  s.write(s.home, '.codex/AGENTS.md', 'global\n');
  s.write(s.home, '.codex/AGENTS.override.md', 'global override\n');
  s.write(s.home, '.codex/config.toml', 'model = "x"\nproject_doc_fallback_filenames = ["TEAM.md", \'OTHER.md\']\n');
  s.write(s.base, 'AGENTS.md', 'above the git root: not loaded\n');
  s.write(s.root, 'AGENTS.md', 'root\n');
  s.write(s.root, 'pkg/AGENTS.md', 'pkg\n');
  s.write(s.root, 'pkg/AGENTS.override.md', 'pkg override\n');
  s.write(s.root, 'pkg/app/AGENTS.md', '   \n'); // empty: falls through to the fallback name
  s.write(s.root, 'pkg/app/TEAM.md', 'team\n');
  s.write(s.root, 'pkg/app/deeper/AGENTS.md', 'below the working directory: not loaded\n');
  const cwd = path.join(s.root, 'pkg', 'app');
  const { config } = loadConfig({ root: cwd });
  const r = measure({ root: cwd, config, agents: ['codex'], home: s.home, env: {}, managedFile: null });
  assert.deepEqual(names(r), [path.join(s.root, 'AGENTS.md'), path.join(s.root, 'pkg', 'AGENTS.override.md'), 'TEAM.md', '~/.codex/AGENTS.override.md'].sort());

  const viaEnv = measure({ root: cwd, config, agents: ['codex'], home: s.home, env: { CODEX_HOME: path.join(s.base, 'nope') }, managedFile: null });
  assert.ok(!names(viaEnv).some((n) => n.includes('.codex')));
  assert.ok(!names(viaEnv).includes('TEAM.md')); // fallback names came from the other home
});

test('Cursor: legacy file, always-apply rules and root instructions only', (t) => {
  const s = sandbox(t);
  s.write(s.root, '.cursorrules', 'legacy\n');
  s.write(s.root, '.cursor/rules/always.mdc', '---\ndescription: x\nalwaysApply: true\n---\nalways\n');
  s.write(s.root, '.cursor/rules/sub/also.mdc', '---\nalwaysApply: true\n---\nnested\n');
  s.write(s.root, '.cursor/rules/glob.mdc', '---\nglobs: "*.ts"\nalwaysApply: false\n---\nscoped\n');
  s.write(s.root, '.cursor/rules/plain.mdc', 'no frontmatter, alwaysApply: true in the body\n');
  s.write(s.root, 'AGENTS.md', 'root\n');
  s.write(s.root, 'sub/AGENTS.md', 'nested: scoped, not always-load\n');
  const r = s.run({ agents: ['cursor'] });
  assert.deepEqual(names(r), ['.cursor/rules/always.mdc', '.cursor/rules/sub/also.mdc', '.cursorrules', 'AGENTS.md']);
  assert.deepEqual(r.agents, ['cursor']);
});

test('a declared surface is the whole surface unless discovery is asked for', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'a'.repeat(40));
  s.write(s.root, 'state.md', 's'.repeat(80));
  s.write(s.root, '.debloat.json', JSON.stringify({ surface: ['state.md', 'gone.md'] }));
  const declared = s.run();
  assert.deepEqual(names(declared), ['state.md']);
  assert.deepEqual(declared.agents, []);
  assert.deepEqual(declared.missing, ['gone.md']);

  const withAgent = s.run({ agents: ['codex'] });
  assert.deepEqual(names(withAgent), ['AGENTS.md', 'state.md']);
  assert.equal(withAgent.by_agent.codex.bytes, 120); // declared files count for every agent

  s.write(s.root, '.debloat.json', JSON.stringify({ surface: ['state.md'], discover: true, agents: ['codex'] }));
  assert.deepEqual(names(s.run()), ['AGENTS.md', 'state.md']);
  assert.deepEqual(names(s.run({ noDiscover: true })), ['state.md']);
});

test('with discovery off and nothing declared, the v1.0 default surface applies', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'CLAUDE.md', 'c\n');
  s.write(s.root, 'AGENTS.md', 'a\n');
  s.write(s.root, '.cursorrules', 'r\n');
  const r = s.run({ noDiscover: true, includes: ['.cursorrules', 'nope.md'] });
  assert.deepEqual(names(r), ['.cursorrules', 'AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(r.missing, ['nope.md']);
});

test('perFileSoft matches by path through any alias, with "*" as the fallback', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'x'.repeat(400)); // 100 tok
  fs.symlinkSync('AGENTS.md', path.join(s.root, 'CLAUDE.md'));
  s.write(s.root, 'other.md', 'x'.repeat(400));
  s.write(s.root, '.debloat.json', JSON.stringify({ surface: ['CLAUDE.md', 'other.md'], perFileSoft: { '*': 500, 'AGENTS.md': 50 } }));
  const r = s.run();
  assert.equal(byName(r, 'CLAUDE.md').soft, 50);
  assert.equal(byName(r, 'CLAUDE.md').heavy, true);
  assert.equal(byName(r, 'other.md').soft, 500);
  assert.equal(byName(r, 'other.md').heavy, false);

  // a declared perFileSoft without "*" leaves other files without a ceiling, as in v1.0
  s.write(s.root, '.debloat.json', JSON.stringify({ surface: ['other.md'], perFileSoft: { 'AGENTS.md': 50 } }));
  assert.equal(byName(s.run(), 'other.md').soft, null);
});

test('a broken config warns and falls back instead of failing', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'a\n');
  s.write(s.root, '.debloat.json', '{ not json');
  const broken = loadConfig({ root: s.root });
  assert.match(broken.warnings[0], /could not parse/);
  assert.deepEqual(broken.config.thresholds, { watch: 8000, heavy: 16000 });

  s.write(s.root, '.debloat.json', JSON.stringify({
    surface: 'AGENTS.md', agents: [1], discover: 'yes', thresholds: { watch: 9000, heavy: 100 },
    perFileSoft: { '*': -1, 'AGENTS.md': 10 }, journal: 5,
  }));
  const bad = loadConfig({ root: s.root });
  assert.equal(bad.warnings.length, 6);
  assert.deepEqual(bad.config.thresholds, { watch: 8000, heavy: 16000 });
  assert.deepEqual(bad.config.perFileSoft, { 'AGENTS.md': 10 });
  assert.equal(bad.config.surface, null);
  assert.equal(bad.config.journal, null);

  s.write(s.root, '.debloat.json', JSON.stringify({ thresholds: { heavy: 20000 } }));
  assert.deepEqual(loadConfig({ root: s.root }).config.thresholds, { watch: 8000, heavy: 20000 });
});

test('an unknown agent is reported and ignored', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'a\n');
  const r = s.run({ agents: ['codex', 'emacs'] });
  assert.deepEqual(r.agents, ['codex']);
  assert.ok(r.warnings.some((w) => /unknown agent "emacs"/.test(w)));
});

test('measurement does not write anything', (t) => {
  const s = sandbox(t);
  s.write(s.root, 'AGENTS.md', 'a\n');
  s.write(s.home, '.claude/CLAUDE.md', 'c\n');
  const snapshot = () => fs.readdirSync(s.base, { recursive: true }).sort().join('\n');
  const before = snapshot();
  s.run({ agents: ['all'] });
  assert.equal(snapshot(), before);
});
