// The verified trim path. Every test runs in its own temp dir.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrimError, apply, prepare, renderDiff } from '../lib/trim.mjs';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const SOURCE = ['# Project', 'rule one', '## Log', '2025-01-01 did a thing', '2025-01-02 did another', '## Current', 'state'].join('\n') + '\n';
const POINTER = 'Older log entries: see NOTES-history.md.';

function sandbox(t, source = SOURCE) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-trim-')));
  t.after(() => {
    for (const d of [base, path.join(base, 'project', 'docs')]) try { fs.chmodSync(d, 0o755); } catch { /* absent */ }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'NOTES.md'), source);
  const plan = (extra = {}) => ({ source: 'NOTES.md', history: 'NOTES-history.md', pointer: POINTER, ranges: [{ start: 3, end: 5 }], ...extra });
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const tree = () => fs.readdirSync(base, { recursive: true }).sort().map((rel) => {
    const st = fs.lstatSync(path.join(base, rel));
    return `${rel} ${st.isFile() ? sha256(fs.readFileSync(path.join(base, rel))) : 'dir'}`;
  }).join('\n');
  return { base, root, plan, read, tree };
}
const refuses = (fn, pattern) => assert.throws(fn, (e) => e instanceof TrimError && pattern.test(e.message));

test('prepare and the diff preview are read-only', (t) => {
  const s = sandbox(t);
  const before = s.tree();
  const p = prepare({ root: s.root, plan: s.plan() });
  const diff = renderDiff(p);
  assert.equal(s.tree(), before);
  assert.match(diff, /^--- a\/NOTES\.md\n\+\+\+ b\/NOTES\.md\n@@ -3,3 \+3,1 @@\n-## Log\n-2025-01-01 did a thing\n-2025-01-02 did another\n\+Older log entries/);
  assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/NOTES-history\.md\n@@ -0,0 \+1,5 @@\n\+<!-- debloat:start source="NOTES\.md" lines=3-5 sha256=[0-9a-f]{64} -->\n\+## Log\n/);
  assert.match(p.review_token, /^[0-9a-f]{64}$/);
});

test('apply moves the exact lines, leaves a pointer, backs up and verifies', (t) => {
  const s = sandbox(t);
  const p = prepare({ root: s.root, plan: s.plan() });
  const result = apply(p, p.review_token);
  assert.equal(result.verified, true);
  assert.equal(s.read('NOTES.md'), `# Project\nrule one\n${POINTER}\n## Current\nstate\n`);
  const moved = '## Log\n2025-01-01 did a thing\n2025-01-02 did another\n';
  assert.equal(s.read('NOTES-history.md'), `<!-- debloat:start source="NOTES.md" lines=3-5 sha256=${sha256(moved)} -->\n${moved}<!-- debloat:end -->\n`);
  assert.equal(sha256(s.read('NOTES.md')), result.hashes.source_after);
  assert.equal(sha256(s.read('NOTES-history.md')), result.hashes.history_after);

  assert.match(result.backup, /^\.debloat\/backups\//);
  assert.equal(s.read(`${result.backup}/source/NOTES.md`), SOURCE);
  const manifest = JSON.parse(s.read(`${result.backup}/manifest.json`));
  assert.equal(manifest.hashes.source_before, sha256(SOURCE));
  assert.equal(manifest.history_existed, false);
  assert.deepEqual(manifest.segments, [{ start: 3, end: 5, sha256: sha256(moved) }]);
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(s.root).sort(), ['.debloat', 'NOTES-history.md', 'NOTES.md']);
});

test('nothing is lost: every source line ends up in the source or the history', (t) => {
  const s = sandbox(t);
  const p = prepare({ root: s.root, plan: s.plan({ ranges: [{ start: 6, end: 7 }, { start: 2, end: 2 }, { start: 4, end: 4 }] }) });
  apply(p, p.review_token);
  const after = s.read('NOTES.md') + s.read('NOTES-history.md');
  for (const line of SOURCE.split('\n').filter(Boolean)) assert.ok(after.includes(line + '\n'), `lost: ${line}`);
  assert.equal(s.read('NOTES.md'), `# Project\n${POINTER}\n## Log\n2025-01-02 did another\n`);
  assert.equal(s.read('NOTES-history.md').match(/debloat:start/g).length, 3);
});

test('appends to an existing history file, keeps modes and backs the history up too', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.root, 'NOTES-history.md'), 'earlier history, no trailing newline');
  fs.chmodSync(path.join(s.root, 'NOTES.md'), 0o600);
  fs.chmodSync(path.join(s.root, 'NOTES-history.md'), 0o640);
  const p = prepare({ root: s.root, plan: s.plan() });
  assert.match(renderDiff(p), /--- a\/NOTES-history\.md\n\+\+\+ b\/NOTES-history\.md\n@@ -1,0 \+2,6 @@\n\+\n\+<!-- debloat:start/);
  const result = apply(p, p.review_token);
  assert.ok(s.read('NOTES-history.md').startsWith('earlier history, no trailing newline\n\n<!-- debloat:start'));
  assert.equal(s.read(`${result.backup}/history/NOTES-history.md`), 'earlier history, no trailing newline');
  assert.equal(fs.statSync(path.join(s.root, 'NOTES.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(s.root, 'NOTES-history.md')).mode & 0o777, 0o640);
});

test('keeps CRLF endings, non-ASCII text and a final line without a newline intact', (t) => {
  const source = 'keep é\r\nmove 日本語\r\nmove 🙂 last';
  const s = sandbox(t, source);
  const p = prepare({ root: s.root, plan: s.plan({ ranges: [{ start: 2, end: 3 }] }) });
  apply(p, p.review_token);
  assert.equal(s.read('NOTES.md'), `keep é\r\n${POINTER}\r\n`);
  const moved = 'move 日本語\r\nmove 🙂 last';
  assert.ok(s.read('NOTES-history.md').includes(`sha256=${sha256(moved)} -->\r\n${moved}\r\n<!-- debloat:end -->\r\n`));
});

test('does not add a second pointer when the same line already stands outside the ranges', (t) => {
  const s = sandbox(t, `# Project\n${POINTER}\nold 1\nold 2\ncurrent\n`);
  const p = prepare({ root: s.root, plan: s.plan({ ranges: [{ start: 3, end: 4 }] }) });
  assert.equal(p.pointer_added, false);
  apply(p, p.review_token);
  assert.equal(s.read('NOTES.md'), `# Project\n${POINTER}\ncurrent\n`);
});

test('refuses to apply without the review token, or with a wrong one, before writing anything', (t) => {
  const s = sandbox(t);
  const before = s.tree();
  const p = prepare({ root: s.root, plan: s.plan() });
  refuses(() => apply(p, null), /needs --review-token/);
  refuses(() => apply(p, ''), /needs --review-token/);
  refuses(() => apply(p, 'f'.repeat(64)), /does not match/);
  assert.equal(s.tree(), before); // no backup directory either
});

test('the token is bound to the previewed content: any change after the preview is refused', (t) => {
  const s = sandbox(t);
  const token = prepare({ root: s.root, plan: s.plan() }).review_token;

  // a different plan
  refuses(() => apply(prepare({ root: s.root, plan: s.plan({ ranges: [{ start: 3, end: 4 }] }) }), token), /does not match/);
  refuses(() => apply(prepare({ root: s.root, plan: s.plan({ pointer: 'another pointer' }) }), token), /does not match/);
  refuses(() => apply(prepare({ root: s.root, plan: s.plan({ history: 'elsewhere.md' }) }), token), /does not match/);

  // the history file appears after the preview
  fs.writeFileSync(path.join(s.root, 'NOTES-history.md'), '');
  refuses(() => apply(prepare({ root: s.root, plan: s.plan() }), token), /does not match/);
  fs.rmSync(path.join(s.root, 'NOTES-history.md'));

  // the source is edited after the preview, even outside the ranges
  fs.appendFileSync(path.join(s.root, 'NOTES.md'), 'one more line\n');
  const before = s.tree();
  refuses(() => apply(prepare({ root: s.root, plan: s.plan() }), token), /does not match/);
  assert.equal(s.tree(), before);
});

test('refuses when a file changes between prepare and apply in the same run', (t) => {
  const s = sandbox(t);
  const p = prepare({ root: s.root, plan: s.plan() });
  fs.appendFileSync(path.join(s.root, 'NOTES.md'), 'raced in\n');
  const before = s.tree();
  refuses(() => apply(p, p.review_token), /changed after the plan was prepared/);
  assert.equal(s.tree(), before);

  const q = prepare({ root: s.root, plan: s.plan() });
  fs.writeFileSync(path.join(s.root, 'NOTES-history.md'), 'raced in\n');
  refuses(() => apply(q, q.review_token), /changed after the plan was prepared/);
  assert.equal(s.read('NOTES-history.md'), 'raced in\n');
});

test('rolls back both files when verification fails after the writes', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.root, 'NOTES-history.md'), 'earlier\n');
  const p = prepare({ root: s.root, plan: s.plan() });
  for (const victim of ['NOTES.md', 'NOTES-history.md']) {
    refuses(() => apply(p, p.review_token, { beforeVerify: () => fs.appendFileSync(path.join(s.root, victim), 'corrupted') }),
      /verification failed.*Rolled back.*Backup kept at/);
    assert.equal(s.read('NOTES.md'), SOURCE);
    assert.equal(s.read('NOTES-history.md'), 'earlier\n');
  }
});

test('rollback removes a history file that did not exist before', (t) => {
  const s = sandbox(t);
  const p = prepare({ root: s.root, plan: s.plan({ history: 'archive/NOTES-history.md' }) });
  refuses(() => apply(p, p.review_token, { beforeVerify: () => { throw new Error('disk went away'); } }), /disk went away\. Rolled back/);
  assert.equal(s.read('NOTES.md'), SOURCE);
  assert.equal(fs.existsSync(path.join(s.root, 'archive', 'NOTES-history.md')), false);
  assert.equal(fs.readdirSync(path.join(s.root, '.debloat', 'backups')).length, 1); // the backup stays
});

test('rolls back the history write when the source cannot be written', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.root, 'docs'));
  fs.renameSync(path.join(s.root, 'NOTES.md'), path.join(s.root, 'docs', 'NOTES.md'));
  fs.writeFileSync(path.join(s.root, 'NOTES-history.md'), 'earlier\n');
  const p = prepare({ root: s.root, plan: s.plan({ source: 'docs/NOTES.md' }) });
  fs.chmodSync(path.join(s.root, 'docs'), 0o555); // the atomic write cannot create its temp file
  refuses(() => apply(p, p.review_token), /Rolled back: source and history are unchanged/);
  assert.equal(s.read('docs/NOTES.md'), SOURCE);
  assert.equal(s.read('NOTES-history.md'), 'earlier\n');
});

test('refuses paths that leave the project root, directly or through symlinks', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.base, 'outside.md'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  fs.mkdirSync(path.join(s.base, 'outside-dir'));
  const before = () => s.tree();
  const snap = before();

  refuses(() => prepare({ root: s.root, plan: s.plan({ source: '../outside.md' }) }), /source must stay inside the project root/);
  refuses(() => prepare({ root: s.root, plan: s.plan({ source: path.join(s.base, 'outside.md') }) }), /source must stay inside/);
  refuses(() => prepare({ root: s.root, plan: s.plan({ history: '../history.md' }) }), /history must stay inside/);

  fs.symlinkSync(path.join(s.base, 'outside.md'), path.join(s.root, 'LINK.md'));
  refuses(() => prepare({ root: s.root, plan: s.plan({ source: 'LINK.md' }) }), /source is a symlink that resolves outside the project root/);
  refuses(() => prepare({ root: s.root, plan: s.plan({ history: 'LINK.md' }) }), /history is a symlink that resolves outside/);

  fs.symlinkSync(path.join(s.base, 'outside-dir'), path.join(s.root, 'linked-dir'));
  refuses(() => prepare({ root: s.root, plan: s.plan({ history: 'linked-dir/new/history.md' }) }), /history has a parent that resolves outside/);

  fs.symlinkSync(path.join(s.base, 'missing.md'), path.join(s.root, 'DANGLING.md'));
  refuses(() => prepare({ root: s.root, plan: s.plan({ history: 'DANGLING.md' }) }), /dangling symlink/);

  for (const link of ['LINK.md', 'linked-dir', 'DANGLING.md']) fs.rmSync(path.join(s.root, link));
  assert.equal(before(), snap);
});

test('refuses to put backups outside the root through a symlinked .debloat', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.base, 'outside-dir'));
  fs.symlinkSync(path.join(s.base, 'outside-dir'), path.join(s.root, '.debloat'));
  const p = prepare({ root: s.root, plan: s.plan() });
  refuses(() => apply(p, p.review_token), /backup directory has a parent that resolves outside/);
  assert.equal(s.read('NOTES.md'), SOURCE);
  assert.deepEqual(fs.readdirSync(path.join(s.base, 'outside-dir')), []);
});

test('a source symlink that stays inside the root is trimmed at its target and stays a symlink', (t) => {
  const s = sandbox(t);
  fs.symlinkSync('NOTES.md', path.join(s.root, 'CLAUDE.md'));
  const p = prepare({ root: s.root, plan: s.plan({ source: 'CLAUDE.md' }) });
  assert.equal(p.source.label, 'NOTES.md');
  apply(p, p.review_token);
  assert.equal(fs.lstatSync(path.join(s.root, 'CLAUDE.md')).isSymbolicLink(), true);
  assert.ok(s.read('CLAUDE.md').includes(POINTER));
});

test('rejects malformed plans', (t) => {
  const s = sandbox(t);
  const bad = (extra, pattern) => refuses(() => prepare({ root: s.root, plan: s.plan(extra) }), pattern);
  bad({ ranges: [] }, /at least one/);
  bad({ ranges: [{ start: 1.5, end: 2 }] }, /integer/);
  bad({ ranges: [{ start: 0, end: 2 }] }, /does not fit/);
  bad({ ranges: [{ start: 4, end: 3 }] }, /does not fit/);
  bad({ ranges: [{ start: 6, end: 8 }] }, /does not fit a 7-line source/);
  bad({ ranges: [{ start: 2, end: 4 }, { start: 4, end: 5 }] }, /ranges overlap/);
  bad({ pointer: '' }, /pointer must be a single non-empty line/);
  bad({ pointer: 'two\nlines' }, /pointer must be a single/);
  bad({ source: 'missing.md' }, /source does not exist/);
  bad({ history: 'NOTES.md' }, /must be different files/);
  bad({ source: '.' }, /source must be a regular file/);
  bad({ history: 'state-history.json' }, /not JSON/);
  bad({ sorce: 'typo.md' }, /unknown plan key: sorce/);
  refuses(() => prepare({ root: s.root, plan: [] }), /plan must be a JSON object/);
  refuses(() => prepare({ root: path.join(s.base, 'nope'), plan: s.plan() }), /root is not a directory/);
});

test('refuses a source that is not valid UTF-8 rather than rewriting it lossily', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.root, 'NOTES.md'), Buffer.concat([Buffer.from('ok\nmove\n'), Buffer.from([0xff, 0xfe, 0x0a])]));
  refuses(() => prepare({ root: s.root, plan: s.plan({ ranges: [{ start: 2, end: 2 }] }) }), /not valid UTF-8/);
});
