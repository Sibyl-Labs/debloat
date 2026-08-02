import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class TrimPlanError extends Error {}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
};

const assertInside = (root, candidate, label) => {
  if (!isInside(root, candidate)) throw new TrimPlanError(`${label} must stay inside the project root`);
};

const existingAncestor = (candidate) => {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

const resolveWritablePath = (root, configuredPath, label, mustExist) => {
  if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
    throw new TrimPlanError(`${label} must be a non-empty path`);
  }
  const lexicalPath = path.resolve(root, configuredPath);
  assertInside(root, lexicalPath, label);
  if (mustExist && !fs.existsSync(lexicalPath)) throw new TrimPlanError(`${label} does not exist: ${configuredPath}`);

  if (fs.existsSync(lexicalPath)) {
    const realPath = fs.realpathSync(lexicalPath);
    assertInside(root, realPath, `${label} symlink target`);
    return realPath;
  }
  const ancestor = fs.realpathSync(existingAncestor(path.dirname(lexicalPath)));
  assertInside(root, ancestor, `${label} parent`);
  return lexicalPath;
};

const splitLines = (content) => content.match(/.*(?:\n|$)/g).filter((line) => line.length > 0);

const normalizeRanges = (ranges, lineCount) => {
  if (!Array.isArray(ranges) || !ranges.length) throw new TrimPlanError('ranges must contain at least one line range');
  const normalized = ranges.map((range) => {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      throw new TrimPlanError('each range must have integer start and end line numbers');
    }
    if (range.start < 1 || range.end < range.start || range.end > lineCount) {
      throw new TrimPlanError(`invalid range ${range.start}-${range.end} for a ${lineCount}-line file`);
    }
    return { start: range.start, end: range.end };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].start <= normalized[index - 1].end) {
      throw new TrimPlanError('ranges must not overlap');
    }
  }
  return normalized;
};

const lineEnding = (content) => content.includes('\r\n') ? '\r\n' : '\n';

const buildHistoryBlock = ({ sourceLabel, range, content, eol }) => {
  const digest = sha256(content);
  const header = `<!-- debloat:start source=${JSON.stringify(sourceLabel)} lines=${range.start}-${range.end} sha256=${digest} -->${eol}`;
  const footerPrefix = content.endsWith('\n') ? '' : eol;
  const footer = `<!-- debloat:end -->${eol}`;
  return { digest, block: `${header}${content}${footerPrefix}${footer}` };
};

export const loadTrimPlan = ({ root, planPath }) => {
  const resolvedPlanPath = resolveWritablePath(root, planPath, 'plan', true);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(resolvedPlanPath, 'utf8'));
  } catch (error) {
    throw new TrimPlanError(`could not parse ${resolvedPlanPath}: ${error.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TrimPlanError('plan must contain a JSON object');
  }
  return plan;
};

export const prepareTrim = ({ root, plan }) => {
  const sourcePath = resolveWritablePath(root, plan.source, 'source', true);
  const historyPath = resolveWritablePath(root, plan.history, 'history', false);
  if (sourcePath === historyPath) throw new TrimPlanError('source and history must be different files');
  if (!fs.statSync(sourcePath).isFile()) throw new TrimPlanError('source must be a regular file');
  if (fs.existsSync(historyPath) && !fs.statSync(historyPath).isFile()) {
    throw new TrimPlanError('history must be a regular file');
  }
  if (typeof plan.pointer !== 'string' || !plan.pointer.trim() || /[\r\n]/.test(plan.pointer)) {
    throw new TrimPlanError('pointer must be one non-empty line');
  }

  const sourceBefore = fs.readFileSync(sourcePath, 'utf8');
  const historyBefore = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : '';
  const sourceLines = splitLines(sourceBefore);
  const ranges = normalizeRanges(plan.ranges, sourceLines.length);
  const eol = lineEnding(sourceBefore);
  const rangeByStart = new Map(ranges.map((range) => [range.start, range]));
  const sourceAfterParts = [];
  const extracted = [];
  const selectedLine = (lineNumber) => ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
  const pointerExistedOutsideRanges = sourceLines.some((line, index) => {
    const value = line.replace(/\r?\n$/, '');
    return !selectedLine(index + 1) && value === plan.pointer;
  });
  let pointerAdded = pointerExistedOutsideRanges;

  for (let lineNumber = 1; lineNumber <= sourceLines.length;) {
    const range = rangeByStart.get(lineNumber);
    if (!range) {
      sourceAfterParts.push(sourceLines[lineNumber - 1]);
      lineNumber += 1;
      continue;
    }
    const content = sourceLines.slice(range.start - 1, range.end).join('');
    const historyBlock = buildHistoryBlock({ sourceLabel: plan.source, range, content, eol });
    extracted.push({ ...range, content, sha256: historyBlock.digest, block: historyBlock.block });
    if (!pointerAdded) {
      sourceAfterParts.push(`${plan.pointer}${eol}`);
      pointerAdded = true;
    }
    lineNumber = range.end + 1;
  }

  const historyPrefix = historyBefore && !historyBefore.endsWith('\n') ? `${historyBefore}${eol}` : historyBefore;
  const historySeparator = historyPrefix && !historyPrefix.endsWith(`${eol}${eol}`) ? eol : '';
  const sourceAfter = sourceAfterParts.join('');
  const historyAfter = `${historyPrefix}${historySeparator}${extracted.map((segment) => segment.block).join(eol)}`;
  const hashes = {
    source_before: sha256(sourceBefore),
    source_after: sha256(sourceAfter),
    history_before: sha256(historyBefore),
    history_after: sha256(historyAfter),
  };
  const reviewToken = sha256(JSON.stringify({
    source: plan.source,
    history: plan.history,
    pointer: plan.pointer,
    ranges,
    source_before: hashes.source_before,
    history_before: hashes.history_before,
  }));

  return {
    root,
    source: { configured: plan.source, path: sourcePath, before: sourceBefore, after: sourceAfter },
    history: { configured: plan.history, path: historyPath, existed: fs.existsSync(historyPath), before: historyBefore, after: historyAfter },
    pointer: plan.pointer,
    pointer_added: !pointerExistedOutsideRanges,
    ranges,
    extracted,
    hashes,
    review_token: reviewToken,
  };
};

const prefixedLines = (content, prefix) => splitLines(content).map((line) => `${prefix}${line}`).join('');

export const renderTrimDiff = (prepared) => {
  const chunks = [];
  chunks.push(`--- a/${prepared.source.configured}\n+++ b/${prepared.source.configured}\n`);
  for (const segment of prepared.extracted) {
    chunks.push(`@@ -${segment.start},${segment.end - segment.start + 1} +${segment.start},1 @@\n`);
    chunks.push(prefixedLines(segment.content, '-'));
    if (segment === prepared.extracted[0] && prepared.pointer_added) chunks.push(`+${prepared.pointer}\n`);
  }
  chunks.push(`--- a/${prepared.history.configured}\n+++ b/${prepared.history.configured}\n@@ append @@\n`);
  const appended = prepared.history.after.slice(prepared.history.before.length);
  chunks.push(prefixedLines(appended, '+'));
  return chunks.join('');
};

const atomicWrite = (target, content, mode) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.debloat-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};

const restore = (target, content, existed, mode) => {
  if (!existed) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }
  atomicWrite(target, content, mode);
};

export const applyTrim = (prepared, reviewToken) => {
  if (!reviewToken || reviewToken !== prepared.review_token) {
    throw new TrimPlanError('review token is missing or does not match the previewed plan');
  }
  const currentSource = fs.readFileSync(prepared.source.path, 'utf8');
  const currentHistory = fs.existsSync(prepared.history.path) ? fs.readFileSync(prepared.history.path, 'utf8') : '';
  if (sha256(currentSource) !== prepared.hashes.source_before || sha256(currentHistory) !== prepared.hashes.history_before) {
    throw new TrimPlanError('source or history changed after the plan was prepared');
  }
  const sourceMode = fs.statSync(prepared.source.path).mode & 0o777;
  const historyMode = prepared.history.existed ? fs.statSync(prepared.history.path).mode & 0o777 : 0o644;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = resolveWritablePath(prepared.root, path.join('.debloat', 'backups', `${timestamp}-${process.pid}`), 'backup directory', false);
  const sourceRelative = path.relative(prepared.root, prepared.source.path);
  const historyRelative = path.relative(prepared.root, prepared.history.path);
  const sourceBackup = path.join(backupRoot, 'source', sourceRelative);
  const historyBackup = path.join(backupRoot, 'history', historyRelative);
  fs.mkdirSync(path.dirname(sourceBackup), { recursive: true });
  fs.copyFileSync(prepared.source.path, sourceBackup);
  if (prepared.history.existed) {
    fs.mkdirSync(path.dirname(historyBackup), { recursive: true });
    fs.copyFileSync(prepared.history.path, historyBackup);
  }

  const manifest = {
    created_at: new Date().toISOString(),
    source: prepared.source.configured,
    history: prepared.history.configured,
    history_existed: prepared.history.existed,
    ranges: prepared.ranges,
    review_token: prepared.review_token,
    hashes: prepared.hashes,
    extracted: prepared.extracted.map(({ start, end, sha256: digest }) => ({ start, end, sha256: digest })),
  };
  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    atomicWrite(prepared.history.path, prepared.history.after, historyMode);
    atomicWrite(prepared.source.path, prepared.source.after, sourceMode);
    const sourceActual = fs.readFileSync(prepared.source.path, 'utf8');
    const historyActual = fs.readFileSync(prepared.history.path, 'utf8');
    const sourceBackupActual = fs.readFileSync(sourceBackup, 'utf8');
    const verified = sha256(sourceActual) === prepared.hashes.source_after
      && sha256(historyActual) === prepared.hashes.history_after
      && sha256(sourceBackupActual) === prepared.hashes.source_before
      && prepared.extracted.every((segment) => historyActual.includes(segment.content));
    if (!verified) throw new TrimPlanError('post-write integrity verification failed');
  } catch (error) {
    restore(prepared.source.path, prepared.source.before, true, sourceMode);
    restore(prepared.history.path, prepared.history.before, prepared.history.existed, historyMode);
    throw error;
  }

  return { backup: backupRoot, hashes: prepared.hashes, verified: true };
};
