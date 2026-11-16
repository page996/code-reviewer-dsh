/**
 * Run store — `.review/runs/<runId>/` artifacts. CONTRACT §7.
 *
 * Artifact names (agents should use these consistently):
 *   meta.json, scope.json, rules.json, plan.json, reviews.json, aggregate.json,
 *   gate.json, report.md, report.json, report.sarif
 *
 * Writes are atomic-ish: write a sibling temp file, then rename over the target.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from './config.mjs';

const RUN_ID_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;
const RUN_FILES = Object.freeze({
  meta: 'meta.json',
  scope: 'scope.json',
  rules: 'rules.json',
  plan: 'plan.json',
  reviews: 'reviews.json',
  review: 'review.json',
  aggregate: 'aggregate.json',
  gate: 'gate.json',
  report: 'report.json',
});

function storeError(message, code = 'SCHEMA', cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Generate `run-YYYYMMDD-HHmmss-<4hex>` (local time). */
export function createRunId(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `run-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** True when a string is a syntactically valid run id. */
export function isRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

function reportsOutDir(config) {
  const configured = config?.report?.outDir;
  const outDir = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULTS.report.outDir;
  return outDir;
}

/** Absolute runs root (`<cwd>/<config.report.outDir>` by default). */
export function runsRoot(cwd, config) {
  const outDir = reportsOutDir(config);
  if (path.isAbsolute(outDir)) return path.normalize(outDir);
  return path.resolve(cwd || process.cwd(), outDir);
}

function sanitizeValue(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/^(api[-_]?key|token|password|secret|authorization)$/i.test(key)) continue;
    out[key] = sanitizeValue(inner, depth + 1);
  }
  return out;
}

/** Deep-clone a config for meta.json while stripping accidental secret fields. */
export function sanitizeConfig(config) {
  return sanitizeValue(config ?? {});
}

function listRunDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw storeError(`cannot read runs directory ${root}: ${err.message}`, 'SCHEMA', err);
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first (fixed-width timestamp)
}

/**
 * Create a run directory and write meta.json.
 * @param {{cwd?: string, config?: object, mode?: string, scope?: object}} [options]
 * @returns {{runId: string, runDir: string, meta: object, metaPath: string}}
 */
export function createRun({ cwd, config, mode, scope } = {}) {
  const baseDir = path.resolve(cwd || process.cwd());
  const root = runsRoot(baseDir, config);
  let runId = typeof scope?.runId === 'string' && scope.runId.trim() ? scope.runId.trim() : null;
  const explicit = Boolean(runId);
  if (!runId) {
    runId = createRunId();
    for (let attempt = 0; attempt < 20 && fs.existsSync(path.join(root, runId)); attempt += 1) {
      runId = createRunId();
    }
  }
  const runDir = path.join(root, runId);
  if (explicit && fs.existsSync(runDir)) {
    throw storeError(`run already exists: ${runId} (${runDir})`, 'USAGE');
  }
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch (err) {
    throw storeError(`cannot create run directory ${runDir}: ${err.message}`, 'SCHEMA', err);
  }

  const resolvedMode = mode || scope?.mode || 'workspace';
  const repo = scope?.repo && typeof scope.repo === 'object' ? scope.repo : { root: baseDir, name: path.basename(baseDir) };
  const meta = {
    schemaVersion: 1,
    runId,
    mode: resolvedMode,
    repo,
    createdAt: new Date().toISOString(),
    ...(scope?.range ? { range: scope.range } : {}),
    config: sanitizeConfig(config),
  };
  const metaPath = writeJson(runDir, 'meta.json', meta);
  return { runId, runDir, meta, metaPath };
}

function jsonFileName(name) {
  const fileName = String(name || '').replace(/^[/\\]+/, '');
  if (!fileName) throw storeError('writeJson: artifact name is required');
  return /\.json$/i.test(fileName) ? fileName : `${fileName}.json`;
}

/**
 * Write one JSON artifact atomically.
 * @returns {string} absolute artifact path
 */
export function writeJson(runDir, name, obj) {
  if (!runDir) throw storeError('writeJson: runDir is required');
  const dir = path.resolve(runDir);
  const fileName = jsonFileName(name);
  const target = path.join(dir, fileName);
  let text;
  try {
    text = `${JSON.stringify(obj, null, 2)}\n`;
  } catch (err) {
    throw storeError(`cannot serialize ${fileName}: ${err.message}`, 'SCHEMA', err);
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    throw storeError(`cannot create directory for ${target}: ${err.message}`, 'SCHEMA', err);
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw storeError(`cannot write ${target}: ${err.message}`, 'SCHEMA', err);
  }
  return target;
}

/**
 * Read one JSON artifact. Returns null when the artifact does not exist.
 */
export function readJson(runDir, name) {
  const dir = path.resolve(runDir);
  const fileName = jsonFileName(name);
  const target = path.join(dir, fileName);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw storeError(`cannot read ${target}: ${err.message}`, 'SCHEMA', err);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw storeError(`invalid JSON in ${target}: ${err.message}`, 'SCHEMA', err);
  }
}

/**
 * Read every known artifact of a run.
 * @returns {{runDir: string, runId: string, meta: object|null, scope: object|null,
 *            rules: object|null, plan: object|null, reviews: object|null,
 *            review: object|null, aggregate: object|null, gate: object|null}}
 */
export function readRun(runDir) {
  if (!runDir) throw storeError('readRun: runDir is required');
  const dir = path.resolve(runDir);
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw storeError(`run directory not found: ${dir}`, 'USAGE');
  const meta = readJson(dir, RUN_FILES.meta);
  return {
    runDir: dir,
    runId: typeof meta?.runId === 'string' && meta.runId ? meta.runId : path.basename(dir),
    meta,
    scope: readJson(dir, RUN_FILES.scope),
    rules: readJson(dir, RUN_FILES.rules),
    plan: readJson(dir, RUN_FILES.plan),
    reviews: readJson(dir, RUN_FILES.reviews),
    review: readJson(dir, RUN_FILES.review),
    aggregate: readJson(dir, RUN_FILES.aggregate),
    gate: readJson(dir, RUN_FILES.gate),
  };
}

/** Absolute path of the newest run, or null. */
export function latestRun(cwd, config) {
  const root = runsRoot(cwd, config);
  const runs = listRunDirs(root);
  return runs.length > 0 ? path.join(root, runs[0]) : null;
}

/** All runs, newest first. */
export function listRuns(cwd, config) {
  const root = runsRoot(cwd, config);
  const runs = listRunDirs(root).map((runId) => {
    const runDir = path.join(root, runId);
    let meta = null;
    try {
      meta = readJson(runDir, RUN_FILES.meta);
    } catch {
      meta = null;
    }
    return { runId, runDir, createdAt: meta?.createdAt ?? null, mode: meta?.mode ?? null, meta };
  });
  runs.sort((a, b) => {
    const left = String(a.createdAt || a.runId);
    const right = String(b.createdAt || b.runId);
    if (left === right) return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
    return left < right ? 1 : -1;
  });
  return runs;
}

/**
 * Resolve a user-supplied run reference to an absolute run directory.
 * Accepts a run id, the literal `latest`, or a filesystem path.
 */
export function resolveRunDir(cwd, config, ref) {
  const baseDir = path.resolve(cwd || process.cwd());
  const rawRef = typeof ref === 'string' ? ref.trim() : '';
  if (!rawRef) throw storeError('--run is required (run id, "latest", or a run directory)', 'USAGE');
  let runDir;
  if (rawRef === 'latest') {
    runDir = latestRun(baseDir, config);
    if (!runDir) throw storeError(`no runs found under ${runsRoot(baseDir, config)}`, 'USAGE');
  } else if (isRunId(rawRef)) {
    runDir = path.join(runsRoot(baseDir, config), rawRef);
  } else if (rawRef.includes('/') || rawRef.includes('\\') || path.isAbsolute(rawRef) || fs.existsSync(path.resolve(baseDir, rawRef))) {
    runDir = path.resolve(baseDir, rawRef);
  } else {
    runDir = path.join(runsRoot(baseDir, config), rawRef);
  }
  let stat = null;
  try {
    stat = fs.statSync(runDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw storeError(`run not found: ${rawRef} (${runDir})`, 'USAGE');
  return runDir;
}
