/**
 * lib/aggregate.mjs — CONTRACT §6: dedupe / vote / grade / status.
 *
 * Input:
 *   reviews  — output of `runReview` (used for review-level human attention/errors)
 *   anchored — flat array of findings that already went through
 *              `anchorFindings` + `filterFindings`; each item SHOULD carry
 *              `lens` (distinct-lens votes) and optionally `unitId`.
 *              Per-unit groups `{ unitId, findings: [...] }` are accepted too.
 *   config   — full config (uses `review.*` and `gate.*`).
 *
 * Output: `{ schemaVersion, findings, counts, verdict, blocking,
 *            humanAttention, errors, stats }`.
 *
 * Fingerprint = sha1(file|category|normalizedTitle|startLine|endLine) (hex).
 */

import { createHash } from 'node:crypto';
import { CATEGORIES, SEVERITIES } from './prompts.mjs';

const CATEGORY_SET = new Set(CATEGORIES);
const SEVERITY_SET = new Set(SEVERITIES);
const SEVERITY_RANK = { blocker: 3, major: 2, minor: 1 };
const DEFAULT_MAX_COMMENTS = 30;
const DEFAULT_VOTES_FOR_MAJOR = 2;
const DEFAULT_BLOCK_ON = ['blocker', 'major'];

function toLine(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePath(value) {
  return toText(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeCategory(value) {
  const text = toText(value).toLowerCase();
  return CATEGORY_SET.has(text) ? text : 'other';
}

function normalizeSeverity(value) {
  const text = toText(value).toLowerCase();
  return SEVERITY_SET.has(text) ? text : 'minor';
}

/** Lowercased, whitespace-collapsed finding title used for fingerprints. */
export function normalizeTitle(finding) {
  const raw =
    (typeof finding?.problem === 'string' && finding.problem.trim() !== ''
      ? finding.problem
      : undefined) ??
    (typeof finding?.title === 'string' ? finding.title : undefined) ??
    (typeof finding?.message === 'string' ? finding.message : undefined) ??
    '';
  return String(raw).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * sha1 fingerprint of a normalized finding: `file|category|title|start|end`.
 * Exported because the filter pass needs stable fingerprints.
 */
export function computeFingerprint(finding) {
  const file = normalizePath(finding?.file);
  const category = normalizeCategory(finding?.category);
  const title = normalizeTitle(finding);
  const startLine = toLine(finding?.startLine ?? finding?.line) ?? '';
  const endLine = toLine(finding?.endLine ?? finding?.startLine ?? finding?.line) ?? '';
  return createHash('sha1')
    .update(`${file}|${category}|${title}|${startLine}|${endLine}`)
    .digest('hex');
}

/**
 * Build the blocking sub-list from aggregated findings (or reuse the one
 * already attached by `aggregateFindings`). Shared with `gate.mjs`.
 */
export function blockingFindings(aggregate, config) {
  if (aggregate && Array.isArray(aggregate.blocking)) {
    return aggregate.blocking.map((item) => ({ ...item }));
  }
  const blockOn = new Set(
    asArray(config?.gate?.blockOn).filter((item) => typeof item === 'string' && item)
  );
  const effectiveBlockOn = blockOn.size > 0 ? blockOn : new Set(DEFAULT_BLOCK_ON);
  const blockPreexisting = config?.gate?.blockPreexisting === true;
  const findings = asArray(aggregate?.findings);
  return findings
    .filter(
      (finding) =>
        finding?.status === 'real' &&
        finding?.blocking !== false &&
        effectiveBlockOn.has(finding.severity) &&
        (!finding.preexisting || blockPreexisting),
    )
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      file: finding.file,
      startLine: finding.startLine ?? null,
      severity: finding.severity,
      title: finding.title ?? finding.problem ?? '',
    }));
}

/* ------------------------------------------------------------------------- */
/* input normalization                                                       */
/* ------------------------------------------------------------------------- */

function flattenAnchored(anchored) {
  const out = [];
  const seen = new Set();
  const visit = (item, depth, inherited) => {
    if (item === null || item === undefined || depth > 4) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1, inherited);
      return;
    }
    if (typeof item !== 'object') return;
    if (Array.isArray(item.findings) && !item.file && !item.problem) {
      for (const child of item.findings) visit(child, depth + 1, item);
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    const merged = { ...item };
    if (merged.lens === undefined && inherited?.lens !== undefined) merged.lens = inherited.lens;
    if (merged.unitId === undefined && inherited?.unitId !== undefined) {
      merged.unitId = inherited.unitId;
    }
    out.push(merged);
  };
  visit(anchored, 0, null);
  return out;
}

function reviewErrors(reviews) {
  const errors = [];
  const attention = [];
  for (const review of asArray(reviews)) {
    if (!review || typeof review !== 'object') continue;
    const lens = typeof review.lens === 'string' ? review.lens : 'unknown';
    const unitId = typeof review.unitId === 'string' ? review.unitId : undefined;
    if (review.error) {
      const error = review.error instanceof Error ? review.error : review.error;
      errors.push({
        unitId,
        lens,
        code: error?.code ?? 'REVIEW',
        message: toText(error?.message ?? error),
      });
    }
    if (typeof review.schemaError === 'string' && review.schemaError.trim() !== '') {
      errors.push({ unitId, lens, code: 'SCHEMA', message: review.schemaError.trim() });
    }
    for (const item of asArray(review.humanAttention)) {
      const text = toText(item);
      if (text) attention.push({ unitId, lens, text });
    }
  }
  return { errors, attention };
}

function normalizeFinding(raw, lensFallback) {
  const explicitAnchor = raw?.anchored;
  const line = toLine(raw?.line);
  const startCandidate = toLine(raw?.startLine ?? raw?.line);
  const endCandidate = toLine(raw?.endLine ?? raw?.startLine ?? raw?.line);
  // `anchored === false` from position.mjs is authoritative: keep it unanchored
  // even if the reviewer supplied a raw `line`.
  const anchored =
    explicitAnchor === false ? false : explicitAnchor === true ? true : startCandidate !== null;
  const findings = {
    ...raw,
    file: normalizePath(raw?.file),
    category: normalizeCategory(raw?.category),
    severity: normalizeSeverity(raw?.severity),
    problem: toText(raw?.problem ?? raw?.title ?? raw?.message),
    evidence: toText(raw?.evidence),
    impact: toText(raw?.impact),
    suggestion: toText(raw?.suggestion ?? raw?.fix),
    existing_code: typeof raw?.existing_code === 'string' ? raw.existing_code : '',
    line,
    startLine: anchored ? startCandidate : null,
    endLine: anchored ? endCandidate ?? startCandidate : null,
    preexisting: raw?.preexisting === true,
    anchored,
  };
  const lens = toText(
    raw?.lens ?? raw?.reviewLens ?? raw?.lensId ?? raw?.review?.lens ?? lensFallback ?? '',
  );
  findings.lens = lens || 'unknown';
  findings.unitId =
    typeof raw?.unitId === 'string' && raw.unitId ? raw.unitId : undefined;
  findings.fingerprint = computeFingerprint(findings);
  return findings;
}

function groupKey(finding) {
  if (finding.anchored && finding.startLine !== null && finding.file) {
    return `${finding.file}|${finding.startLine}|${finding.category}`;
  }
  return `fp:${finding.fingerprint}`;
}

function mergeGroup(group) {
  const sorted = [...group].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    const problemDiff = b.problem.length - a.problem.length;
    if (problemDiff !== 0) return problemDiff;
    return String(a.fingerprint).localeCompare(String(b.fingerprint));
  });
  const base = sorted[0];
  const lenses = [...new Set(group.map((finding) => finding.lens).filter(Boolean))].sort();
  const unitIds = [...new Set(group.map((finding) => finding.unitId).filter(Boolean))].sort();
  const preexistingCount = group.filter((finding) => finding.preexisting).length;
  const maxSeverity = sorted[0].severity;
  const firstText = (field) => {
    for (const finding of sorted) {
      if (typeof finding[field] === 'string' && finding[field].trim() !== '') return finding[field];
    }
    return '';
  };
  const anchoredItems = group.filter(
    (finding) => finding.anchored && finding.startLine !== null,
  );
  const startLine = anchoredItems.length
    ? Math.min(...anchoredItems.map((finding) => finding.startLine))
    : null;
  const endLine = anchoredItems.length
    ? Math.max(...anchoredItems.map((finding) => finding.endLine ?? finding.startLine))
    : null;

  const merged = {
    fingerprint: base.fingerprint,
    file: base.file,
    startLine,
    endLine,
    line: base.line,
    anchored: anchoredItems.length > 0,
    anchorReason: base.anchored ? base.anchorReason : base.anchorReason ?? 'unanchored',
    hunkId: base.hunkId ?? null,
    category: base.category,
    severity: maxSeverity,
    problem: firstText('problem'),
    evidence: firstText('evidence'),
    impact: firstText('impact'),
    suggestion: firstText('suggestion'),
    existing_code: firstText('existing_code'),
    preexisting: preexistingCount * 2 > group.length,
    votes: lenses.length,
    lenses,
    unitIds,
    status: 'real',
    blocking: false,
    occurrences: group.length,
  };
  // Preserve extra string fields from the representative finding (e.g. rule).
  for (const key of Object.keys(base)) {
    if (merged[key] === undefined && !key.startsWith('_')) merged[key] = base[key];
  }
  delete merged._index;
  merged.title = merged.problem;
  return merged;
}

/* ------------------------------------------------------------------------- */
/* public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {{reviews?: Array, anchored?: Array, config?: object}} args
 */
export function aggregateFindings({ reviews, anchored, config } = {}) {
  const reviewList = asArray(reviews);
  const { errors, attention } = reviewErrors(reviewList);

  const normalized = flattenAnchored(anchored)
    .filter((raw) => raw && typeof raw === 'object')
    .map((raw) => normalizeFinding(raw, undefined));

  // Dedupe: (file,startLine,category) for anchored findings; fingerprint for
  // unanchored ones (otherwise every same-category finding on a file collapses).
  const groups = new Map();
  for (const finding of normalized) {
    const key = groupKey(finding);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }

  const votesForMajor =
    Number.isFinite(Number(config?.review?.votesForMajor)) &&
    Number(config?.review?.votesForMajor) > 0
      ? Math.floor(Number(config.review.votesForMajor))
      : DEFAULT_VOTES_FOR_MAJOR;
  const blockOn = new Set(
    asArray(config?.gate?.blockOn).filter((item) => typeof item === 'string' && item),
  );
  const effectiveBlockOn = blockOn.size > 0 ? blockOn : new Set(DEFAULT_BLOCK_ON);
  const blockPreexisting = config?.gate?.blockPreexisting === true;

  const findings = [];
  for (const group of groups.values()) {
    const merged = mergeGroup(group);
    // severity 取最高；票数不足时 major/blocker 降级为 minor。
    if (merged.severity !== 'minor' && merged.votes < votesForMajor) {
      merged.downgradedFrom = merged.severity;
      merged.severity = 'minor';
    }
    // 风格/文档类 minor 直接丢弃。
    if ((merged.category === 'style' || merged.category === 'docs') && merged.severity === 'minor') {
      merged.status = 'dropped';
      merged.dropReason = 'style-minor';
    } else if (merged.evidence === '') {
      // 没有证据的断言不吞掉，转人工判断。
      merged.status = 'needs-human';
      merged.needsHuman = true;
    } else {
      merged.status = 'real';
    }
    merged.blocking =
      merged.status === 'real' &&
      effectiveBlockOn.has(merged.severity) &&
      (!merged.preexisting || blockPreexisting);
    findings.push(merged);
  }

  // maxComments 截断：按 severity 排序，优先保留 needs-human（不占配额）。
  const maxComments =
    Number.isFinite(Number(config?.review?.maxComments)) && Number(config?.review?.maxComments) > 0
      ? Math.floor(Number(config.review.maxComments))
      : DEFAULT_MAX_COMMENTS;
  const needsHumanFindings = findings.filter((finding) => finding.status === 'needs-human');
  const realFindings = findings
    .filter((finding) => finding.status === 'real')
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (rankDiff !== 0) return rankDiff;
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (a.preexisting !== b.preexisting) return a.preexisting ? 1 : -1;
      if ((a.startLine ?? Infinity) !== (b.startLine ?? Infinity)) {
        return (a.startLine ?? Infinity) - (b.startLine ?? Infinity);
      }
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return String(a.fingerprint).localeCompare(String(b.fingerprint));
    });
  const keptReal = realFindings.slice(0, maxComments);
  const trimmedReal = realFindings.slice(maxComments);
  for (const finding of trimmedReal) {
    finding.status = 'dropped';
    finding.dropReason = 'max-comments';
    finding.blocking = false;
  }

  const finalFindings = [...keptReal, ...needsHumanFindings, ...trimmedReal, ...findings.filter(
    (finding) => finding.status === 'dropped' && finding.dropReason === 'style-minor',
  )];
  // Deduplicate object identity (a finding is only in one bucket, but be safe).
  const uniqueFindings = [...new Set(finalFindings)];

  const counts = { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 };
  for (const finding of uniqueFindings) {
    if (finding.status === 'dropped') counts.dropped += 1;
    else if (finding.status === 'needs-human') counts.needsHuman += 1;
    else {
      if (finding.severity === 'blocker') counts.blocker += 1;
      else if (finding.severity === 'major') counts.major += 1;
      else counts.minor += 1;
    }
  }

  const blocking = uniqueFindings
    .filter((finding) => finding.blocking)
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (rankDiff !== 0) return rankDiff;
      return String(a.fingerprint).localeCompare(String(b.fingerprint));
    })
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      file: finding.file,
      startLine: finding.startLine ?? null,
      severity: finding.severity,
      title: finding.title ?? finding.problem ?? '',
    }));

  // `humanAttention` holds reviewer questions ("is this intended?") — they are useful context,
  // but they are not blocking findings: a run with only minor findings must still pass CI.
  // The verdict is therefore driven by blocking findings and needs-human *findings* only.
  const humanAttention = attention.map((item) => item.text).slice(0, 10);
  let verdict = 'pass';
  if (blocking.length > 0) verdict = 'block';
  else if (counts.needsHuman > 0 || errors.length > 0) verdict = 'needs-human';

  const anchoredCount = uniqueFindings.filter((finding) => finding.anchored).length;
  return {
    schemaVersion: 1,
    findings: uniqueFindings,
    counts,
    verdict,
    blocking,
    humanAttention,
    errors,
    stats: {
      totalFindings: uniqueFindings.length,
      anchored: anchoredCount,
      unanchored: uniqueFindings.length - anchoredCount,
      reviews: reviewList.length,
      votesForMajor,
    },
  };
}

export default aggregateFindings;
