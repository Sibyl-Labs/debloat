import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const measureCli = path.join(repositoryRoot, 'context-hygiene.mjs');
const trimCli = path.join(repositoryRoot, 'trim-context.mjs');
const temporaryRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-cli-'));
const run = (script, argumentsList, cwd) => spawnSync(process.execPath, [script, ...argumentsList], {
  cwd,
  encoding: 'utf8',
});

test('measurement CLI rejects an unknown agent', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(measureCli, ['--agent', 'unknown'], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown agent/);
});

test('measurement CLI refuses a journal parent symlink outside root', (t) => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'instructions\n');
  fs.symlinkSync(outside, path.join(root, 'journal-link'));
  fs.writeFileSync(path.join(root, '.debloat.json'), JSON.stringify({
    discover: false,
    surface: ['AGENTS.md'],
    journal: 'journal-link/history.jsonl',
  }));

  const result = run(measureCli, ['--json'], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /journal parent symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'history.jsonl')), false);
});

test('trim CLI dry-run prints a diff without writing', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'Current rule.\nOld note.\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), source);
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({
    source: 'AGENTS.md',
    history: 'AGENTS-history.md',
    pointer: 'Historical notes: see AGENTS-history.md.',
    ranges: [{ start: 2, end: 2 }],
  }));

  const result = run(trimCli, ['--plan', 'plan.json', '--dry-run'], root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /-Old note\./);
  assert.match(result.stdout, /review token: [a-f0-9]{64}/);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS-history.md')), false);
});

test('trim CLI refuses apply without the token from dry-run', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Current rule.\nOld note.\n');
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({
    source: 'AGENTS.md',
    history: 'AGENTS-history.md',
    pointer: 'Historical notes: see AGENTS-history.md.',
    ranges: [{ start: 2, end: 2 }],
  }));

  const result = run(trimCli, ['--plan', 'plan.json', '--apply'], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /review token/);
  assert.equal(fs.existsSync(path.join(root, '.debloat')), false);
});

test('trim CLI applies the exact previewed plan with its review token', (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Current rule.\nOld note.\n');
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({
    source: 'AGENTS.md',
    history: 'AGENTS-history.md',
    pointer: 'Historical notes: see AGENTS-history.md.',
    ranges: [{ start: 2, end: 2 }],
  }));
  const preview = run(trimCli, ['--plan', 'plan.json', '--dry-run'], root);
  const token = preview.stdout.match(/review token: ([a-f0-9]{64})/)?.[1];
  assert(token);

  const result = run(trimCli, ['--plan', 'plan.json', '--apply', '--review-token', token], root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /trim applied and verified/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Old note/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS-history.md'), 'utf8'), /Old note/);
  assert(fs.existsSync(path.join(root, '.debloat', 'backups')));
});
