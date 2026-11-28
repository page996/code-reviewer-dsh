/**
 * eval.mjs — case regression evaluator (CONTRACT §11).
 *
 * A case directory captures what a real review found (`findings.json`) and how each
 * item was dispositioned by a human (`dispositions.json`). `review eval` compares a
 * new run's aggregate findings against that baseline:
 *
 *   - accepted  -> must still be reported; missing = recall regression
 *   - fixed     -> must NOT be reported anymore; reported = stale/regression
 *   - rejected  -> must NOT be reported anymore; reported = precision regression
 *   - ignored   -> same as rejected (known noise, must stay quiet)
 *
 * New findings that were not in the baseline are informational (`newFindings`), not
 * regressions: the point is to catch regression, not to freeze the review output.
 *
 * Two sources of false regressions are handled explicitly:
 *   1. Baseline findings for files absent from this run's scope are `notEvaluated`
 *      (batch A of a case must not fail a batch B run).
 *   2. The same issue is worded/anchored slightly differently across runs, so after
 *      fingerprint/exact keys we fall back to same file + category with a nearby line
 *      or a similar title (Jaccard >= 0.45).
 */
import fs from 'node:fs';
import path from 'node:path';

import { computeFingerprint, normalizeTitle } from './aggregate.mjs';
import { readJson, resolveRunDir } from './store.mjs';

const DISPOSITIONS = ['accepted', 'fixed', 'rejected', 'ignored'];
const LINE_TOLERANCE = 20;
const TITLE_SIMILARITY = 0.3;

function evalError(message, code = 'CONFIG') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw evalError(`cannot read ${file}: ${err.message}`, 'SCHEMA');
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw evalError(`invalid JSON in ${file}: ${err.message}`, 'SCHEMA');
  }
}

function asFindings(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.findings)) return value.findings;
  return [];
}

function normFile(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Fuzzy matching may cross category labels (models drift between errors/security/
 * concurrency for the same issue) but must never match across families: a "tests: no
 * tests in unit" baseline item is not the same issue as a nearby code finding.
 */
function categoryFamily(category) {
  const value = String(category ?? '');
  if (value === 'tests') return 'tests';
  if (value === 'style' || value === 'docs') return 'docs';
  return 'code';
}

function toLine(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Title features: ASCII words plus CJK character bigrams. Chinese issue titles have no
 * spaces, so a word split would make every rephrasing disjoint; bigrams keep the
 * similarity meaningful across runs.
 */
function titleFeatures(finding) {
  const text = normalizeTitle(finding).toLowerCase();
  const features = new Set(text.split(/[^a-z0-9]+/).filter((token) => token.length > 1));
  const cjk = [...text].filter((char) => /[\u4e00-\u9fff]/.test(char));
  for (let index = 0; index + 1 < cjk.length; index += 1) features.add(cjk[index] + cjk[index + 1]);
  return features;
}

function titleSimilarity(a, b) {
  const left = titleFeatures(a);
  const right = titleFeatures(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const feature of left) if (right.has(feature)) common += 1;
  return common / (left.size + right.size - common);
}

function matchKey(finding) {
  return [normFile(finding.file), String(finding.category ?? ''), normalizeTitle(finding)].join('|');
}

function looseKey(finding) {
  return [
    normFile(finding.file),
    String(toLine(finding.startLine ?? finding.line) ?? ''),
    String(finding.category ?? ''),
  ].join('|');
}

function indexFindings(findings) {
  const byFingerprint = new Map();
  const byKey = new Map();
  const byLoose = new Map();
  const byFile = new Map();
  for (const finding of findings) {
    let fingerprint = null;
    try {
      fingerprint = computeFingerprint(finding);
    } catch {
      fingerprint = null;
    }
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, finding);
    const key = matchKey(finding);
    if (!byKey.has(key)) byKey.set(key, finding);
    const loose = looseKey(finding);
    if (!byLoose.has(loose) && (finding.startLine ?? finding.line) != null) byLoose.set(loose, finding);
    const group = normFile(finding.file);
    const bucket = byFile.get(group);
    if (bucket) bucket.push(finding);
    else byFile.set(group, [finding]);
  }
  return { byFingerprint, byKey, byLoose, byFile };
}

function findMatch(finding, index) {
  let fingerprint = null;
  try {
    fingerprint = computeFingerprint(finding);
  } catch {
    fingerprint = null;
  }
  if (fingerprint && index.byFingerprint.has(fingerprint)) {
    return { matched: index.byFingerprint.get(fingerprint), how: 'fingerprint' };
  }
  const key = matchKey(finding);
  if (index.byKey.has(key)) return { matched: index.byKey.get(key), how: 'key' };
  const loose = looseKey(finding);
  if (index.byLoose.has(loose)) return { matched: index.byLoose.get(loose), how: 'line' };

  // Fuzzy: same file, nearby line OR similar title. Category labels and wording drift
  // between runs (errors↔security↔concurrency), so category only adds a score bonus.
  const candidates = index.byFile.get(normFile(finding.file)) ?? [];
  const wantedLine = toLine(finding.startLine ?? finding.line);
  const wantedCategory = String(finding.category ?? '');
  const wantedFamily = categoryFamily(wantedCategory);
  let best = null;
  for (const candidate of candidates) {
    if (categoryFamily(candidate.category) !== wantedFamily) continue;
    const candidateLine = toLine(candidate.startLine ?? candidate.line);
    const lineDistance =
      wantedLine === null || candidateLine === null ? null : Math.abs(wantedLine - candidateLine);
    const similarity = titleSimilarity(finding, candidate);
    const closeLine = lineDistance !== null && lineDistance <= LINE_TOLERANCE;
    if (!closeLine && similarity < TITLE_SIMILARITY) continue;
    const sameCategory = String(candidate.category ?? '') === wantedCategory;
    const score = (closeLine ? 2 : 0) + (sameCategory ? 0.5 : 0) + similarity;
    if (!best || score > best.score) best = { candidate, score, how: closeLine ? 'nearby-line' : 'title' };
  }
  return best ? { matched: best.candidate, how: best.how } : { matched: null, how: null };
}

/**
 * Load a case directory (findings baseline + dispositions).
 * @param {string} caseDir
 * @returns {{caseDir: string, findings: object[], dispositions: object[]}}
 */
export function loadCase(caseDir) {
  const dir = path.resolve(caseDir);
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw evalError(`case directory not found: ${dir}`, 'USAGE');

  const findingsRaw = readJsonFile(path.join(dir, 'findings.json'));
  const dispositionsRaw = readJsonFile(path.join(dir, 'dispositions.json'));
  const findings = asFindings(findingsRaw);
  // Accept the documented v1 wrapper ({ schemaVersion, dispositions }) as well
  // as the historical bare array; both carry the same entries. The wrapper is
  // recognized ONLY with schemaVersion 1 — anything else falls back to the
  // legacy reading. Invalid states still fail below instead of being dropped.
  const dispositions = Array.isArray(dispositionsRaw)
    ? dispositionsRaw
    : dispositionsRaw?.schemaVersion === 1 && Array.isArray(dispositionsRaw?.dispositions)
      ? dispositionsRaw.dispositions
      : asFindings(dispositionsRaw);

  for (const item of dispositions) {
    // A malformed entry (null, string, missing state) must fail with the
    // schema error, not an opaque TypeError mid-loop.
    if (!item || typeof item !== 'object' || !DISPOSITIONS.includes(item.disposition)) {
      throw evalError(
        `invalid disposition entry${item && typeof item === 'object' ? ` "${String(item.disposition)}"` : ''} (expected ${DISPOSITIONS.join('|')})`,
        'SCHEMA',
      );
    }
  }
  return { caseDir: dir, findings, dispositions };
}

/**
 * Resolve which baseline finding a disposition applies to.
 * Dispositions can carry an explicit `fingerprint`; otherwise they match by file+category
 * and (substring) title, or by startLine when no title is given.
 */
function resolveDisposition(finding, dispositions) {
  const fingerprint = (() => {
    try {
      return computeFingerprint(finding);
    } catch {
      return null;
    }
  })();
  const byFingerprint = dispositions.find((item) => item.fingerprint && item.fingerprint === fingerprint);
  if (byFingerprint) return byFingerprint;
  const file = normFile(finding.file);
  const category = String(finding.category ?? '');
  return (
    dispositions.find((item) => {
      if (item.fingerprint) return false;
      if (normFile(item.file) !== file) return false;
      if (item.category && item.category !== category) return false;
      const title = normalizeTitle(finding);
      if (item.title && !title.includes(normalizeTitle({ title: item.title }))) return false;
      if (!item.title && item.startLine != null) {
        return toLine(item.startLine) === toLine(finding.startLine ?? finding.line);
      }
      return true;
    }) ?? null
  );
}

/**
 * Evaluate a case against one run.
 * @param {{caseDir: string, cwd?: string, config?: object, runDir?: string, log?: Function}} [options]
 * @returns {object} machine-readable evaluation result
 */
export function evalCase({ caseDir, cwd, config, runDir, log } = {}) {
  const loaded = loadCase(caseDir);
  const resolvedRunDir = runDir
    ? (path.isAbsolute(runDir) ? runDir : path.resolve(cwd || process.cwd(), runDir))
    : resolveRunDir(cwd, config, 'latest');
  const aggregate = readJson(resolvedRunDir, 'aggregate');
  if (!aggregate) throw evalError(`run has no aggregate.json: ${resolvedRunDir}`, 'SCHEMA');
  // Aggregated-but-dropped findings are not part of the review verdict; keep them out of
  // the regression comparison (otherwise every style/docs drop shows as a "new finding").
  const current = asFindings(aggregate).filter((finding) => finding?.status !== 'dropped');
  const index = indexFindings(current);

  const scope = readJson(resolvedRunDir, 'scope');
  const scopeFiles = new Set(
    (Array.isArray(scope?.files) ? scope.files : [])
      .filter((file) => file?.reviewable !== false)
      .map((file) => normFile(file.path)),
  );

  const matched = [];
  const missed = [];
  const stale = [];
  const noiseStillReported = [];
  const notEvaluated = [];
  const matchedCurrent = new Set();

  for (const finding of loaded.findings) {
    const disposition = resolveDisposition(finding, loaded.dispositions);
    const status = disposition?.disposition ?? 'accepted';
    const record = {
      file: normFile(finding.file),
      startLine: finding.startLine ?? finding.line ?? null,
      category: finding.category ?? null,
      title: normalizeTitle(finding),
      disposition: status,
      matchedBy: null,
      dispositionReason: disposition?.reason ?? null,
    };
    // A run only covers its own scope: baseline findings for files outside it are not a
    // regression, they simply were not part of this batch.
    if (scopeFiles.size > 0 && !scopeFiles.has(record.file)) {
      notEvaluated.push(record);
      continue;
    }
    const { matched: hit, how } = findMatch(finding, index);
    record.matchedBy = how;
    if (status === 'accepted') {
      if (hit) {
        matched.push(record);
        matchedCurrent.add(hit);
      } else {
        missed.push(record);
      }
      continue;
    }
    if (status === 'fixed') {
      if (hit) {
        stale.push(record);
        matchedCurrent.add(hit);
      }
      continue;
    }
    // rejected / ignored: known noise, must not come back.
    if (hit) {
      noiseStillReported.push(record);
      matchedCurrent.add(hit);
    }
  }

  const newFindings = current
    .filter((finding) => !matchedCurrent.has(finding))
    .map((finding) => ({
      file: normFile(finding.file),
      startLine: finding.startLine ?? finding.line ?? null,
      category: finding.category ?? null,
      severity: finding.severity ?? null,
      title: normalizeTitle(finding),
    }));

  const regressions = missed.length + stale.length + noiseStillReported.length;
  const result = {
    schemaVersion: 1,
    caseId: path.basename(loaded.caseDir),
    caseDir: loaded.caseDir,
    runDir: resolvedRunDir,
    runId: aggregate.runId ?? path.basename(resolvedRunDir),
    baseline: {
      total: loaded.findings.length,
      accepted: loaded.findings.filter((finding) => (resolveDisposition(finding, loaded.dispositions)?.disposition ?? 'accepted') === 'accepted').length,
      dispositions: loaded.dispositions.length,
    },
    current: { total: current.length },
    counts: {
      matched: matched.length,
      missed: missed.length,
      stale: stale.length,
      noiseStillReported: noiseStillReported.length,
      notEvaluated: notEvaluated.length,
      newFindings: newFindings.length,
      regressions,
    },
    matched,
    missed,
    stale,
    noiseStillReported,
    notEvaluated,
    newFindings,
    verdict: regressions > 0 ? 'regress' : 'pass',
    exitCode: regressions > 0 ? 2 : 0,
  };
  log?.('info', `eval: case=${result.caseId} matched=${matched.length} missed=${missed.length} stale=${stale.length} noise=${noiseStillReported.length} out-of-scope=${notEvaluated.length} new=${newFindings.length}`);
  return result;
}

export default evalCase;
