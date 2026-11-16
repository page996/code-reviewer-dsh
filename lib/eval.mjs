/**
 * Case regression evaluator — CONTRACT §11.
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
 */
import fs from 'node:fs';
import path from 'node:path';

import { computeFingerprint, normalizeTitle } from './aggregate.mjs';
import { readJson, resolveRunDir } from './store.mjs';

const DISPOSITIONS = ['accepted', 'fixed', 'rejected', 'ignored'];

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

function matchKey(finding) {
  return [
    String(finding.file ?? ''),
    String(finding.category ?? ''),
    normalizeTitle(finding),
  ].join('|');
}

function looseKey(finding) {
  return [String(finding.file ?? ''), String(finding.startLine ?? finding.line ?? ''), String(finding.category ?? '')].join('|');
}

function indexFindings(findings) {
  const byFingerprint = new Map();
  const byKey = new Map();
  const byLoose = new Map();
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
  }
  return { byFingerprint, byKey, byLoose };
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
  return { matched: null, how: null };
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
  const dispositions = Array.isArray(dispositionsRaw)
    ? dispositionsRaw
    : asFindings(dispositionsRaw).filter((item) => item && DISPOSITIONS.includes(item.disposition));

  for (const item of dispositions) {
    if (!DISPOSITIONS.includes(item.disposition)) {
      throw evalError(`invalid disposition "${item.disposition}" (expected ${DISPOSITIONS.join('|')})`, 'SCHEMA');
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
  const file = String(finding.file ?? '');
  const category = String(finding.category ?? '');
  return (
    dispositions.find((item) => {
      if (item.file !== file) return false;
      if (item.category && item.category !== category) return false;
      if (item.fingerprint) return false;
      const title = normalizeTitle(finding);
      if (item.title && !title.includes(normalizeTitle({ title: item.title }))) return false;
      if (!item.title && item.startLine != null) {
        return Number(item.startLine) === Number(finding.startLine ?? finding.line ?? NaN);
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
  const current = asFindings(aggregate);
  const index = indexFindings(current);

  const matched = [];
  const missed = [];
  const stale = [];
  const noiseStillReported = [];
  const matchedCurrent = new Set();

  for (const finding of loaded.findings) {
    const disposition = resolveDisposition(finding, loaded.dispositions);
    const status = disposition?.disposition ?? 'accepted';
    const { matched: hit, how } = findMatch(finding, index);
    const record = {
      file: finding.file,
      startLine: finding.startLine ?? finding.line ?? null,
      category: finding.category ?? null,
      title: normalizeTitle(finding),
      disposition: status,
      matchedBy: how,
      dispositionReason: disposition?.reason ?? null,
    };
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
      file: finding.file,
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
      newFindings: newFindings.length,
      regressions,
    },
    matched,
    missed,
    stale,
    noiseStillReported,
    newFindings,
    verdict: regressions > 0 ? 'regress' : 'pass',
    exitCode: regressions > 0 ? 2 : 0,
  };
  log?.('info', `eval: case=${result.caseId} matched=${matched.length} missed=${missed.length} stale=${stale.length} noise=${noiseStillReported.length} new=${newFindings.length}`);
  return result;
}

export default evalCase;
