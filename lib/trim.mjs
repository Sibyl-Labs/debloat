// lib/trim.mjs - deterministic, verified trim: move line ranges from a source file into a history
// file and leave a one-line pointer behind.
//
// prepare() is read-only. It validates the plan, computes both resulting files byte for byte and
// derives a review token from the plan, the current content and the result. apply() writes only
// when given that token, so what lands on disk is exactly what was previewed.
//
// Safety properties:
//   - source, history and backups must resolve inside the project root, symlinks included
//   - nothing is deleted: every extracted range lands in the history file with its SHA-256
//   - apply refuses if the plan, the source or the history changed after the preview
//   - a verified backup is taken before the first write
//   - writes are atomic (temp file + fsync + rename), history first, then source
//   - both files are re-read and hash-checked after writing; any failure rolls both back
//
// Node 18+ (no dependencies).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class TrimError extends Error {}

const PLAN_KEYS = ['source', 'history', 'pointer', 'ranges'];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const isInside = (dir, p) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const posix = (p) => p.split(path.sep).join('/');
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

// ---- path confinement --------------------------------------------------------------------
// Returns the real path for `given`, refusing anything that leaves `root` either as written or
// through a symlink. For a path that does not exist yet, its nearest existing parent is checked.
function resolveInside(root, given, what, { mustExist = false } = {}) {
  if (typeof given !== 'string' || !given.trim()) throw new TrimError(`${what} must be a non-empty path`);
  const lexical = path.resolve(root, given);
  if (!isInside(root, lexical)) throw new TrimError(`${what} must stay inside the project root: ${given}`);
  const st = lstat(lexical);
  if (st) {
    let real;
    try { real = fs.realpathSync(lexical); } catch { throw new TrimError(`${what} is a dangling symlink: ${given}`); }
    if (!isInside(root, real)) throw new TrimError(`${what} is a symlink that resolves outside the project root: ${given}`);
    return real;
  }
  if (mustExist) throw new TrimError(`${what} does not exist: ${given}`);
  let parent = path.dirname(lexical);
  while (!lstat(parent)) parent = path.dirname(parent);
  let realParent;
  try { realParent = fs.realpathSync(parent); } catch { throw new TrimError(`${what} has a dangling symlink in its path: ${given}`); }
  if (!isInside(root, realParent)) throw new TrimError(`${what} has a parent that resolves outside the project root: ${given}`);
  return path.join(realParent, path.relative(parent, lexical));
}

// Reads a file as text, refusing content that would not survive a decode/encode round trip.
function readUtf8(file, what) {
  const raw = fs.readFileSync(file);
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) throw new TrimError(`${what} is not valid UTF-8 text; refusing to rewrite it`);
  return text;
}

const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []; // each line keeps its own ending

// ---- plan --------------------------------------------------------------------------------
export function loadPlan({ root, planPath }) {
  if (!planPath) throw new TrimError('--plan <path> is required');
  const file = path.resolve(root, planPath);
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new TrimError(`could not read plan ${file}: ${e.message}`); }
  return plan;
}

function checkRanges(ranges, lineCount) {
  if (!Array.isArray(ranges) || !ranges.length) throw new TrimError('ranges must list at least one { "start", "end" } line range');
  const out = ranges.map((r) => {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) throw new TrimError('each range needs integer "start" and "end" line numbers (1-based, inclusive)');
    if (r.start < 1 || r.end < r.start || r.end > lineCount) throw new TrimError(`range ${r.start}-${r.end} does not fit a ${lineCount}-line source`);
    return { start: r.start, end: r.end };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) {
    if (out[i].start <= out[i - 1].end) throw new TrimError(`ranges overlap: ${out[i - 1].start}-${out[i - 1].end} and ${out[i].start}-${out[i].end}`);
  }
  return out;
}

// ---- PREPARE (read-only) -----------------------------------------------------------------
export function prepare({ root, plan }) {
  try { root = fs.realpathSync(root); } catch { throw new TrimError(`root is not a directory: ${root}`); }
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) throw new TrimError('plan must be a JSON object');
  const unknown = Object.keys(plan).filter((k) => !PLAN_KEYS.includes(k));
  if (unknown.length) throw new TrimError(`unknown plan key: ${unknown.join(', ')} (expected ${PLAN_KEYS.join(', ')})`);

  const sourcePath = resolveInside(root, plan.source, 'source', { mustExist: true });
  const historyPath = resolveInside(root, plan.history, 'history');
  if (sourcePath === historyPath) throw new TrimError('source and history must be different files');
  if (!fs.statSync(sourcePath).isFile()) throw new TrimError('source must be a regular file');
  const historyExisted = fs.existsSync(historyPath);
  if (historyExisted && !fs.statSync(historyPath).isFile()) throw new TrimError('history must be a regular file');
  // Line moves plus comment markers would corrupt structured data. Trim those by hand.
  for (const p of [sourcePath, historyPath]) {
    if (/\.(json|jsonl|ndjson)$/i.test(p)) throw new TrimError(`${posix(path.relative(root, p))}: line-based trim is for text and markdown, not JSON`);
  }
  if (typeof plan.pointer !== 'string' || !plan.pointer.trim() || /[\r\n]/.test(plan.pointer)) throw new TrimError('pointer must be a single non-empty line');

  const sourceBefore = readUtf8(sourcePath, 'source');
  const historyBefore = historyExisted ? readUtf8(historyPath, 'history') : '';
  const lines = splitLines(sourceBefore);
  const ranges = checkRanges(plan.ranges, lines.length);
  const eol = sourceBefore.includes('\r\n') ? '\r\n' : '\n';
  const sourceLabel = posix(path.relative(root, sourcePath));
  const historyLabel = posix(path.relative(root, historyPath));

  // The pointer goes where the first range was, unless the same line already stands elsewhere.
  const inRange = (n) => ranges.some((r) => n >= r.start && n <= r.end);
  const pointerPresent = lines.some((l, i) => !inRange(i + 1) && l.replace(/\r?\n$/, '') === plan.pointer);
  const kept = [];
  const segments = [];
  let cursor = 1;
  for (const r of ranges) {
    kept.push(...lines.slice(cursor - 1, r.start - 1));
    if (!pointerPresent && !segments.length) kept.push(plan.pointer + eol);
    const content = lines.slice(r.start - 1, r.end).join('');
    const digest = sha256(content);
    // ">" is escaped so a file name can never close the comment early
    const head = `<!-- debloat:start source=${JSON.stringify(sourceLabel).replace(/>/g, '\\u003e')} lines=${r.start}-${r.end} sha256=${digest} -->${eol}`;
    const block = `${head}${content}${content.endsWith('\n') ? '' : eol}<!-- debloat:end -->${eol}`;
    segments.push({ start: r.start, end: r.end, sha256: digest, content, block });
    cursor = r.end + 1;
  }
  kept.push(...lines.slice(cursor - 1));
  const sourceAfter = kept.join('');

  let historyAfter = historyBefore;
  if (historyAfter && !historyAfter.endsWith('\n')) historyAfter += eol;
  if (historyAfter) historyAfter += eol; // blank line between existing history and the new blocks
  historyAfter += segments.map((s) => s.block).join(eol);

  const hashes = {
    source_before: sha256(sourceBefore), source_after: sha256(sourceAfter),
    history_before: sha256(historyBefore), history_after: sha256(historyAfter),
  };
  // The token covers the plan, what is on disk now and what would be written.
  const reviewToken = sha256(JSON.stringify({ v: 1, source: sourceLabel, history: historyLabel, history_existed: historyExisted, pointer: plan.pointer, ranges, hashes }));
  const chars = (t) => { let c = 0; for (const _ of t) c++; return c; };

  return {
    root,
    source: { label: sourceLabel, path: sourcePath, before: sourceBefore, after: sourceAfter },
    history: { label: historyLabel, path: historyPath, existed: historyExisted, before: historyBefore, after: historyAfter },
    pointer: plan.pointer, pointer_added: !pointerPresent,
    ranges, segments, hashes,
    lines_moved: ranges.reduce((n, r) => n + r.end - r.start + 1, 0),
    source_chars: { before: chars(sourceBefore), after: chars(sourceAfter) },
    review_token: reviewToken,
  };
}

// ---- PREVIEW -----------------------------------------------------------------------------
// Unified-style diff of everything the plan would change. No context lines: only what moves.
export function renderDiff(p) {
  const mark = (text, sign) => splitLines(text).map((l) => sign + (l.endsWith('\n') ? l : l + '\n')).join('');
  let out = `--- a/${p.source.label}\n+++ b/${p.source.label}\n`;
  let shift = 0; // how far new line numbers trail the old ones
  p.segments.forEach((s, i) => {
    const count = s.end - s.start + 1;
    const added = i === 0 && p.pointer_added ? 1 : 0;
    out += `@@ -${s.start},${count} +${s.start - shift},${added} @@\n${mark(s.content, '-')}`;
    if (added) out += `+${p.pointer}\n`;
    shift += count - added;
  });
  let appended = p.history.after.slice(p.history.before.length);
  // a newline that only completes the existing last line is not a new line; leave it out of the view
  if (p.history.before && !p.history.before.endsWith('\n')) appended = appended.replace(/^\r?\n/, '');
  const at = splitLines(p.history.before).length;
  out += `--- ${p.history.existed ? 'a/' + p.history.label : '/dev/null'}\n+++ b/${p.history.label}\n`;
  out += `@@ -${at},0 +${at + 1},${splitLines(appended).length} @@\n${mark(appended, '+')}`;
  return out;
}

// ---- APPLY -------------------------------------------------------------------------------
function atomicWrite(target, text, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.debloat-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode); // exclusive: never follows or reuses an existing path
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.chmodSync(tmp, mode); // the umask may have narrowed the mode at creation
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already failing */ }
    try { fs.unlinkSync(tmp); } catch { /* renamed away, or never created */ }
  }
}

const hashOf = (file) => sha256(fs.readFileSync(file));

// `hooks.beforeVerify` exists for tests: it runs between the writes and the verification.
export function apply(p, reviewToken, hooks = {}) {
  if (typeof reviewToken !== 'string' || !reviewToken) throw new TrimError('--apply needs --review-token <token> from a --dry-run of this plan');
  if (reviewToken !== p.review_token) {
    throw new TrimError('review token does not match: the plan, the source or the history changed after the preview (or the token is wrong). Nothing was written. Run --dry-run again and review the new diff.');
  }
  // Re-check the disk right before writing, in case something changed since prepare() read it.
  const historyNow = fs.existsSync(p.history.path);
  if (hashOf(p.source.path) !== p.hashes.source_before || historyNow !== p.history.existed
    || (historyNow && hashOf(p.history.path) !== p.hashes.history_before)) {
    throw new TrimError('source or history changed after the plan was prepared. Nothing was written. Run --dry-run again.');
  }

  const sourceMode = fs.statSync(p.source.path).mode & 0o777;
  const historyMode = p.history.existed ? fs.statSync(p.history.path).mode & 0o777 : sourceMode;

  // BACKUP first, and prove it is good before touching anything.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = resolveInside(p.root, path.join('.debloat', 'backups', `${stamp}-${crypto.randomBytes(3).toString('hex')}`), 'backup directory');
  const sourceBackup = path.join(backupDir, 'source', path.relative(p.root, p.source.path));
  const historyBackup = path.join(backupDir, 'history', path.relative(p.root, p.history.path));
  fs.mkdirSync(path.dirname(sourceBackup), { recursive: true });
  fs.copyFileSync(p.source.path, sourceBackup, fs.constants.COPYFILE_EXCL);
  if (p.history.existed) {
    fs.mkdirSync(path.dirname(historyBackup), { recursive: true });
    fs.copyFileSync(p.history.path, historyBackup, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    created_at: new Date().toISOString(), source: p.source.label, history: p.history.label,
    history_existed: p.history.existed, pointer: p.pointer, ranges: p.ranges,
    segments: p.segments.map(({ start, end, sha256: digest }) => ({ start, end, sha256: digest })),
    hashes: p.hashes, review_token: p.review_token,
  }, null, 2) + '\n');
  if (hashOf(sourceBackup) !== p.hashes.source_before || (p.history.existed && hashOf(historyBackup) !== p.hashes.history_before)) {
    throw new TrimError(`backup verification failed in ${backupDir}. Nothing was written.`);
  }

  // WRITE history first: if the run dies between the two writes, the content exists twice, never zero times.
  try {
    atomicWrite(p.history.path, p.history.after, historyMode);
    atomicWrite(p.source.path, p.source.after, sourceMode);
    hooks.beforeVerify?.();
    // VERIFY from disk, not from memory.
    const historyDisk = fs.readFileSync(p.history.path, 'utf8');
    if (hashOf(p.source.path) !== p.hashes.source_after) throw new TrimError('verification failed: source on disk does not match the preview');
    if (sha256(historyDisk) !== p.hashes.history_after) throw new TrimError('verification failed: history on disk does not match the preview');
    for (const s of p.segments) {
      if (!historyDisk.includes(s.block)) throw new TrimError(`verification failed: lines ${s.start}-${s.end} are not intact in the history file`);
    }
  } catch (err) {
    // ROLLBACK both files to their pre-apply bytes, then confirm it.
    try {
      const differs = (file, hash) => { try { return hashOf(file) !== hash; } catch { return true; } };
      if (differs(p.source.path, p.hashes.source_before)) atomicWrite(p.source.path, p.source.before, sourceMode);
      if (!p.history.existed) fs.rmSync(p.history.path, { force: true });
      else if (differs(p.history.path, p.hashes.history_before)) atomicWrite(p.history.path, p.history.before, historyMode);
      if (hashOf(p.source.path) !== p.hashes.source_before || (p.history.existed && hashOf(p.history.path) !== p.hashes.history_before)) throw new Error('restored files do not match their original hashes');
    } catch (undo) {
      throw new TrimError(`${err.message}. ROLLBACK FAILED (${undo.message}). Restore by hand from ${backupDir}`);
    }
    throw new TrimError(`${err.message}. Rolled back: source and history are unchanged. Backup kept at ${backupDir}`);
  }

  return {
    verified: true, source: p.source.label, history: p.history.label,
    backup: posix(path.relative(p.root, backupDir)), lines_moved: p.lines_moved,
    source_chars: p.source_chars, hashes: p.hashes,
  };
}
