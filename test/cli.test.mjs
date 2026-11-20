// End-to-end runs of both scripts. Child processes get a temp root and a fake HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEASURE = path.join(REPO, 'context-hygiene.mjs');
const TRIM = path.join(REPO, 'trim-context.mjs');

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(home);
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }; // no CODEX_HOME, no CLAUDE_CONFIG_DIR
  const run = (script, args, cwd = root) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
  return { base, root, home, write, run };
}

test('measure: --fyi keeps the v1.0 line format', (t) => {
  const s = sandbox(t);
  s.write('CLAUDE.md', 'x'.repeat(400));
  const light = s.run(MEASURE, ['--fyi', '--no-discover']);
  assert.equal(light.status, 0);
  assert.equal(light.stdout, 'context: ~0.1k tok always-load (light)\n');

  s.write('.debloat.json', JSON.stringify({ surface: ['CLAUDE.md', '.claude/rules.md'], perFileSoft: { '.claude/rules.md': 50 } }));
  s.write('.claude/rules.md', 'x'.repeat(400));
  const watch = s.run(MEASURE, ['--fyi']);
  assert.equal(watch.stdout, 'context: ~0.2k tok always-load (watch) | heavy: rules.md 100t - /debloat to trim\n');
});

test('measure: --json keeps every v1.0 field and adds the new ones', (t) => {
  const s = sandbox(t);
  s.write('.debloat.json', JSON.stringify({ surface: ['CLAUDE.md'], thresholds: { watch: 45000, heavy: 55000 }, perFileSoft: { 'CLAUDE.md': 50 } }));
  s.write('CLAUDE.md', 'é'.repeat(400));
  const r = s.run(MEASURE, ['--json']);
  assert.equal(r.status, 0);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.root, s.root);
  assert.equal(rec.total_tok, 100);
  assert.equal(rec.total_chars, 400);
  assert.equal(rec.total_bytes, 800);
  assert.deepEqual(rec.ref, { watch: 45000, heavy: 55000 });
  assert.equal(rec.weight, 'watch');
  assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  const { file, tok, soft, heavy, chars, bytes } = rec.files[0];
  assert.deepEqual({ file, tok, soft, heavy, chars, bytes }, { file: 'CLAUDE.md', tok: 100, soft: 50, heavy: true, chars: 400, bytes: 800 });
  assert.deepEqual(rec.targets, [{ file: 'CLAUDE.md', kind: 'file_heavy', tok: 100, soft: 50,
    suggestion: 'CLAUDE.md is 100 tok (soft 50). Move accreted history to a *-history file; keep current state + a pointer.' }]);
  assert.deepEqual(rec.estimate, { method: 'chars/4', exact: false });
});

test('measure: the report labels the token figure an estimate and lists bytes and characters', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'é'.repeat(4000));
  const r = s.run(MEASURE, ['--agent', 'codex']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /always-load surface: 1,000 tok {3}\[ESTIMATE~ chars\/4\]/);
  assert.match(r.stdout, /measured: 4,000 chars \/ 8,000 bytes in 1 file/);
  assert.match(r.stdout, /reference: light <8k \/ watch <16k \/ heavy >=16k/);
  assert.match(r.stdout, /agent: codex/);
  assert.match(r.stdout, /Light\. Nothing to do\./);
});

test('measure: discovery uses the fake home, --agent narrows it, --no-discover turns it off', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'project\n');
  s.write('CLAUDE.md', 'project\n');
  fs.mkdirSync(path.join(s.home, '.codex'));
  fs.mkdirSync(path.join(s.home, '.claude'));
  fs.writeFileSync(path.join(s.home, '.codex', 'AGENTS.md'), 'global codex\n');
  fs.writeFileSync(path.join(s.home, '.claude', 'CLAUDE.md'), 'global claude\n');
  const files = (args) => JSON.parse(s.run(MEASURE, ['--json', ...args]).stdout).files.map((f) => f.file);

  assert.deepEqual(files(['--agent', 'codex']).sort(), ['AGENTS.md', '~/.codex/AGENTS.md']);
  const all = files([]);
  for (const want of ['AGENTS.md', 'CLAUDE.md', '~/.codex/AGENTS.md', '~/.claude/CLAUDE.md']) assert.ok(all.includes(want), want);
  const claude = files(['--agent', 'claude']);
  assert.ok(claude.includes('~/.claude/CLAUDE.md') && !claude.includes('~/.codex/AGENTS.md'));
  assert.deepEqual(files(['--no-discover']).sort(), ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(files(['--no-discover', '--include', '~/.codex/AGENTS.md']).sort(), ['AGENTS.md', 'CLAUDE.md', '~/.codex/AGENTS.md']);
});

test('measure: never a gate, so bad input still exits 0 with a warning', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'a\n');
  s.write('.debloat.json', '{ broken');
  const broken = s.run(MEASURE, ['--fyi', '--agent', 'codex']);
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, /debloat: could not parse/);
  assert.match(broken.stdout, /^context: ~0\.0k tok always-load \(light\)\n$/);

  fs.rmSync(path.join(s.root, '.debloat.json'));
  const unknown = s.run(MEASURE, ['--json', '--agent', 'emacs']);
  assert.equal(unknown.status, 0);
  assert.match(unknown.stderr, /unknown agent "emacs"/);
  assert.deepEqual(JSON.parse(unknown.stdout).files, []);

  const noRoot = s.run(MEASURE, ['--root', path.join(s.base, 'nope'), '--agent', 'cursor']);
  assert.equal(noRoot.status, 0);
  assert.match(noRoot.stdout, /no always-load files found/);
});

test('measure: the journal appends inside the root and is refused outside it', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'x'.repeat(40));
  s.write('.debloat.json', JSON.stringify({ surface: ['AGENTS.md'], journal: '.debloat/history.jsonl' }));
  s.run(MEASURE, ['--fyi']);
  s.run(MEASURE, ['--fyi']);
  const lines = fs.readFileSync(path.join(s.root, '.debloat', 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]), ['ts', 'total_tok', 'total_chars', 'total_bytes', 'weight', 'targets']);
  assert.equal(lines[0].total_tok, 10);

  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  for (const journal of ['../outside/j.jsonl', path.join(outside, 'j.jsonl'), 'link/j.jsonl']) {
    fs.rmSync(path.join(s.root, 'link'), { force: true });
    if (journal.startsWith('link')) fs.symlinkSync(outside, path.join(s.root, 'link'));
    s.write('.debloat.json', JSON.stringify({ surface: ['AGENTS.md'], journal }));
    const r = s.run(MEASURE, ['--fyi']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /journal skipped: journal path must stay inside the root/);
    assert.match(r.stdout, /^context: /);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('scripts resolve their library from the installed skill directory, whatever the cwd', (t) => {
  const s = sandbox(t);
  for (const dir of ['.claude/skills/debloat', '.agents/skills/debloat']) {
    const skill = path.join(s.root, dir);
    fs.mkdirSync(path.join(skill, 'lib'), { recursive: true });
    for (const f of ['context-hygiene.mjs', 'trim-context.mjs', 'lib/surface.mjs', 'lib/trim.mjs']) fs.copyFileSync(path.join(REPO, f), path.join(skill, f));
    s.write('pkg/AGENTS.md', 'nested\n');
    const r = s.run(path.join(skill, 'context-hygiene.mjs'), ['--fyi', '--agent', 'codex'], path.join(s.root, 'pkg'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^context: ~0\.0k tok always-load \(light\)\n$/);
    assert.equal(s.run(path.join(skill, 'trim-context.mjs'), ['--help']).status, 0);
  }
});

test('trim: dry run prints the diff and a token, writes nothing; apply needs that token', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'keep\nold 1\nold 2\nkeep too\n');
  s.write('.debloat/trim-plan.json', JSON.stringify({ source: 'AGENTS.md', history: 'AGENTS-history.md', pointer: 'History: AGENTS-history.md', ranges: [{ start: 2, end: 3 }] }));
  const plan = ['--plan', '.debloat/trim-plan.json'];
  const listing = () => fs.readdirSync(s.root, { recursive: true }).sort().join('\n');
  const before = listing();

  const dry = s.run(TRIM, [...plan, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /@@ -2,2 \+2,1 @@\n-old 1\n-old 2\n\+History: AGENTS-history\.md\n/);
  assert.match(dry.stdout, /dry run: nothing written\. 2 lines would move from AGENTS\.md to AGENTS-history\.md/);
  const token = /^review token: ([0-9a-f]{64})$/m.exec(dry.stdout)[1];
  assert.equal(listing(), before);
  assert.equal(JSON.parse(s.run(TRIM, [...plan, '--dry-run', '--json']).stdout).review_token, token);

  for (const args of [[...plan, '--apply'], [...plan, '--apply', '--review-token', '0'.repeat(64)]]) {
    const refused = s.run(TRIM, args);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^debloat: .*review.token/);
  }
  assert.equal(listing(), before);

  // an edit after the preview invalidates the token
  fs.appendFileSync(path.join(s.root, 'AGENTS.md'), 'edited after preview\n');
  const stale = s.run(TRIM, [...plan, '--apply', '--review-token', token]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /changed after the preview/);
  assert.equal(listing(), before);

  const token2 = /^review token: ([0-9a-f]{64})$/m.exec(s.run(TRIM, [...plan, '--dry-run']).stdout)[1];
  assert.notEqual(token2, token);
  const done = s.run(TRIM, [...plan, '--apply', '--review-token', token2, '--json']);
  assert.equal(done.status, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(s.root, 'AGENTS.md'), 'utf8'), 'keep\nHistory: AGENTS-history.md\nkeep too\nedited after preview\n');
  assert.ok(fs.existsSync(path.join(s.root, result.backup, 'source', 'AGENTS.md')));

  // the same token cannot be replayed against the new content
  assert.equal(s.run(TRIM, [...plan, '--apply', '--review-token', token2]).status, 1);
});

test('trim: usage errors and refusals exit 1 with a debloat: message', (t) => {
  const s = sandbox(t);
  s.write('AGENTS.md', 'a\nb\n');
  s.write('plan.json', JSON.stringify({ source: '../../etc/hosts', history: 'h.md', pointer: 'p', ranges: [{ start: 1, end: 1 }] }));
  s.write('bad.json', '{');
  const cases = [
    [['--plan', 'plan.json'], /choose exactly one/],
    [['--plan', 'plan.json', '--dry-run', '--apply'], /choose exactly one/],
    [['--dry-run'], /--plan <path> is required/],
    [['--plan', 'missing.json', '--dry-run'], /could not read plan/],
    [['--plan', 'bad.json', '--dry-run'], /could not read plan/],
    [['--plan', 'plan.json', '--dry-run'], /source must stay inside the project root/],
  ];
  for (const [args, pattern] of cases) {
    const r = s.run(TRIM, args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, pattern);
    assert.match(r.stderr, /^debloat: /);
  }
});
