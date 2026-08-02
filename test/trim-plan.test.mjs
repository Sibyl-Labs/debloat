import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrimPlanError, applyTrim, prepareTrim, renderTrimDiff } from '../lib/trim-plan.mjs';

const temporaryRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-trim-'));

const fixture = (root) => {
  const source = '# Instructions\n\nCurrent rule.\n\n## 2024 notes\nOld event one.\nOld event two.\n\nCurrent ending.\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), source);
  return {
    source,
    plan: {
      source: 'AGENTS.md',
      history: 'AGENTS-history.md',
      pointer: 'Historical notes: see [AGENTS-history.md](AGENTS-history.md).',
      ranges: [{ start: 5, end: 8 }],
    },
  };
};

test('dry-run rendering does not modify either file', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, plan } = fixture(root);
  const prepared = prepareTrim({ root, plan });

  const diff = renderTrimDiff(prepared);

  assert.match(diff, /--- a\/AGENTS\.md/);
  assert.match(diff, /-Old event one\./);
  assert.match(diff, /\+Historical notes:/);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS-history.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.debloat')), false);
});

test('apply backs up, moves exact content, and verifies both outputs', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { plan } = fixture(root);
  const prepared = prepareTrim({ root, plan });
  const extracted = prepared.extracted[0].content;

  const result = applyTrim(prepared, prepared.review_token);
  const sourceAfter = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const historyAfter = fs.readFileSync(path.join(root, 'AGENTS-history.md'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backup, 'manifest.json'), 'utf8'));

  assert.equal(result.verified, true);
  assert(!sourceAfter.includes('Old event one.'));
  assert(sourceAfter.includes(plan.pointer));
  assert(historyAfter.includes(extracted));
  assert.equal(manifest.extracted[0].sha256, prepared.extracted[0].sha256);
  assert.equal(
    fs.readFileSync(path.join(result.backup, 'source', 'AGENTS.md'), 'utf8'),
    prepared.source.before,
  );
});

test('rejects a missing or stale review token before creating a backup', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { plan } = fixture(root);
  const prepared = prepareTrim({ root, plan });

  assert.throws(
    () => applyTrim(prepared, 'stale-token'),
    (error) => error instanceof TrimPlanError && /review token/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, '.debloat')), false);
});

test('rejects source changes made after preview', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { plan } = fixture(root);
  const prepared = prepareTrim({ root, plan });
  fs.appendFileSync(path.join(root, 'AGENTS.md'), 'Concurrent change.\n');

  assert.throws(
    () => applyTrim(prepared, prepared.review_token),
    (error) => error instanceof TrimPlanError && /changed after/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, '.debloat')), false);
});

test('rejects overlapping ranges', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { plan } = fixture(root);
  plan.ranges = [{ start: 3, end: 5 }, { start: 5, end: 7 }];

  assert.throws(
    () => prepareTrim({ root, plan }),
    (error) => error instanceof TrimPlanError && /must not overlap/.test(error.message),
  );
});

test('keeps exactly one pointer when the same line already exists outside the trim range', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pointer = 'Historical notes: see history.md.';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `Current.\n${pointer}\nOld note.\n`);

  const prepared = prepareTrim({
    root,
    plan: {
      source: 'AGENTS.md',
      history: 'history.md',
      pointer,
      ranges: [{ start: 3, end: 3 }],
    },
  });

  assert.equal(prepared.pointer_added, false);
  assert.equal(prepared.source.after.split(pointer).length - 1, 1);
  assert.doesNotMatch(renderTrimDiff(prepared), /^\+Historical notes:/m);
});

test('refuses a source symlink that escapes the project root', (t) => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'shared.md'), 'outside\n');
  fs.symlinkSync(path.join(outside, 'shared.md'), path.join(root, 'AGENTS.md'));

  assert.throws(
    () => prepareTrim({
      root,
      plan: {
        source: 'AGENTS.md',
        history: 'history.md',
        pointer: 'See history.md.',
        ranges: [{ start: 1, end: 1 }],
      },
    }),
    (error) => error instanceof TrimPlanError && /symlink target/.test(error.message),
  );
});
