/**
 * Plan builder — CONTRACT §4.
 *
 * Turns a scope into review units: effort -> lenses, deterministic grouping,
 * per-file unified patches (synthesized for scan/untracked), bound rule packs
 * and skipped-file ledger. Pure: returns plan.json shaped data, writes nothing.
 */
import { DEFAULTS, EFFORTS, LENSES, configError } from './config.mjs';
import { filePatch, parsePatchNewLines } from './git.mjs';
import { resolveRulesForFile } from './rules.mjs';

/** effort -> lens set (CONTRACT §4). `review.lenses` overrides this. */
export const EFFORT_LENSES = Object.freeze({
  quick: Object.freeze(['intent', 'correctness']),
  standard: Object.freeze(['intent', 'correctness', 'errors', 'security', 'tests', 'contract']),
  deep: Object.freeze(['intent', 'correctness', 'errors', 'concurrency', 'data', 'security', 'contract', 'tests', 'scope', 'history']),
});

export const GROUP_MODES = Object.freeze(['auto', 'perfile', 'none']);

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function configErrorFor(message) {
  return configError(message);
}

function planConfig(config) {
  const provided = config?.plan && typeof config.plan === 'object' ? config.plan : {};
  const maxFilesPerUnit = Number.isInteger(provided.maxFilesPerUnit) && provided.maxFilesPerUnit > 0 ? provided.maxFilesPerUnit : DEFAULTS.plan.maxFilesPerUnit;
  const maxLinesPerUnit = Number.isInteger(provided.maxLinesPerUnit) && provided.maxLinesPerUnit > 0 ? provided.maxLinesPerUnit : DEFAULTS.plan.maxLinesPerUnit;
  const groupBy = GROUP_MODES.includes(provided.groupBy) ? provided.groupBy : DEFAULTS.plan.groupBy;
  return { maxFilesPerUnit, maxLinesPerUnit, groupBy };
}

/** Effective lens list for an effort, honoring an explicit override. */
export function effectiveLenses({ effort, config, lenses } = {}) {
  const resolvedEffort = effort || config?.review?.effort || DEFAULTS.review.effort;
  if (!EFFORTS.includes(resolvedEffort)) {
    throw configErrorFor(`invalid effort: ${JSON.stringify(resolvedEffort)} (expected quick|standard|deep)`);
  }
  let list = null;
  if (Array.isArray(lenses) && lenses.length > 0) list = lenses;
  else if (Array.isArray(config?.review?.lenses) && config.review.lenses.length > 0) list = config.review.lenses;
  if (list) {
    for (const lens of list) {
      if (!LENSES.includes(lens)) throw configErrorFor(`invalid lens: ${JSON.stringify(lens)}`);
    }
    return { effort: resolvedEffort, lenses: [...list] };
  }
  return { effort: resolvedEffort, lenses: [...EFFORT_LENSES[resolvedEffort]] };
}

/**
 * Group key for `groupBy=auto`: top-level directory, with special buckets for
 * `shared/` and test roots. Root-level files share the "(root)" bucket.
 */
export function bucketForPath(filePath) {
  const segments = String(filePath ?? '').split('/').filter(Boolean);
  if (segments.length <= 1) return '(root)';
  const first = segments[0];
  const lower = first.toLowerCase();
  if (lower === 'shared') return 'shared';
  if (lower === 'tests' || lower === 'test' || lower === '__tests__' || lower === 'spec' || lower === 'specs') return 'tests';
  return first;
}

/**
 * Greedy packing into units, honoring max files / max lines. A single file that
 * exceeds the line budget still forms its own unit (files are never split).
 * @param {Array<{path: string, newLineCount: number}>} files sorted file list
 */
export function packFiles(files, { maxFilesPerUnit, maxLinesPerUnit } = {}) {
  const maxFiles = Number.isInteger(maxFilesPerUnit) && maxFilesPerUnit > 0 ? maxFilesPerUnit : DEFAULTS.plan.maxFilesPerUnit;
  const maxLines = Number.isInteger(maxLinesPerUnit) && maxLinesPerUnit > 0 ? maxLinesPerUnit : DEFAULTS.plan.maxLinesPerUnit;
  const units = [];
  let current = [];
  let currentLines = 0;
  for (const file of files) {
    const lines = Number.isFinite(file.newLineCount) ? file.newLineCount : 0;
    if (current.length > 0 && (current.length >= maxFiles || currentLines + lines > maxLines)) {
      units.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(file);
    currentLines += lines;
  }
  if (current.length > 0) units.push(current);
  return units;
}

function unitRulesForFiles({ files, rules, config }) {
  const maxChars = config?.rules?.maxCharsPerFile ?? DEFAULTS.rules.maxCharsPerFile;
  const byId = new Map();
  for (const file of files) {
    const resolved = resolveRulesForFile({ path: file.path, rules, maxChars });
    for (const rule of resolved) {
      const existing = byId.get(rule.id);
      if (!existing) {
        byId.set(rule.id, rule);
        continue;
      }
      // Prefer the non-truncated body when different files had different budgets.
      if (existing.truncated && !rule.truncated) byId.set(rule.id, rule);
    }
  }
  const order = new Map();
  if (Array.isArray(rules)) rules.forEach((rule, index) => order.set(rule.id, index));
  return Array.from(byId.values())
    .sort((a, b) => {
      const left = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
      const right = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return compareStrings(a.id, b.id);
    })
    .map((rule) => ({
      id: rule.id,
      source: rule.source,
      title: rule.title,
      severityHint: rule.severityHint ?? null,
      body: rule.body,
    }));
}

function reviewableFiles(scope) {
  const files = Array.isArray(scope?.files) ? scope.files : [];
  return files
    .filter((file) => file && file.reviewable)
    .map((file) => ({
      path: file.path,
      status: file.status ?? 'modified',
      oldPath: file.oldPath ?? null,
      language: file.language ?? null,
    }));
}

function computePatch({ cwd, mode, range, file }) {
  const patch = filePatch({
    cwd,
    path: file.path,
    mode,
    base: range?.base ?? undefined,
    head: range?.head ?? undefined,
    commit: range?.commit ?? undefined,
    oldPath: file.oldPath ?? undefined,
    status: file.status,
  });
  const text = patch || '';
  const { newLines } = parsePatchNewLines(text);
  return { patch: text, newLineCount: newLines.size };
}

/** Lenses that are not useful when the unit only contains the reviewed file (scan mode). */
export const SCAN_SKIP_LENSES = Object.freeze(['tests']);

/** Drop scan-mode-unfriendly lenses unless the caller explicitly asked for them. */
function lensesForMode(list, mode, explicit) {
  if (explicit || mode !== 'scan') return list;
  const filtered = list.filter((lens) => !SCAN_SKIP_LENSES.includes(lens));
  return filtered.length > 0 ? filtered : list;
}

/**
 * Split a synthesized full-add patch (scan mode / untracked) into line-range chunks.
 * Returns null when the patch is not a single full-add hunk, so diff-mode patches are
 * never sliced here.
 */
function splitFullAddPatch({ patch, newLineCount, chunkLines }) {
  const lines = String(patch || '').split('\n');
  const hunkIndex = lines.findIndex((line) => line.startsWith('@@'));
  if (hunkIndex < 0) return null;
  if (!lines[hunkIndex].startsWith('@@ -0,0 +1')) return null;
  const header = lines.slice(0, hunkIndex);
  const body = lines.slice(hunkIndex + 1).filter((line) => line.startsWith('+'));
  if (body.length === 0 || body.length !== newLineCount) return null;
  const chunks = [];
  for (let start = 0; start < body.length; start += chunkLines) {
    const slice = body.slice(start, start + chunkLines);
    const startLine = start + 1;
    const endLine = start + slice.length;
    chunks.push({
      patch: [...header, `@@ -0,0 +${startLine},${slice.length} @@`, ...slice].join('\n'),
      newLineCount: slice.length,
      startLine,
      endLine,
    });
  }
  return chunks.length > 1 ? chunks : null;
}

/** Split oversized single-file scan units so one review request never carries a huge file. */
function expandSingleFileGroups(groups, { mode, config }) {
  const splitLines = Number(config?.plan?.splitSingleFileLines ?? DEFAULTS.plan.splitSingleFileLines);
  if (mode !== 'scan' || !Number.isFinite(splitLines) || splitLines <= 0) return groups;
  const out = [];
  for (const group of groups) {
    if (group.length !== 1) {
      out.push(group);
      continue;
    }
    const [file] = group;
    if (!file.newLineCount || file.newLineCount <= splitLines) {
      out.push(group);
      continue;
    }
    const chunks = splitFullAddPatch({
      patch: file.patch,
      newLineCount: file.newLineCount,
      chunkLines: Math.floor(splitLines),
    });
    if (!chunks) {
      out.push(group);
      continue;
    }
    for (const chunk of chunks) out.push([{ ...file, __chunk: chunk }]);
  }
  return out;
}

/**
 * Build plan.json shaped data.
 * @param {{scope: object, config?: object, effort?: string, lenses?: string[],
 *          rules?: Array<object>, log?: Function}} options
 * @returns {object}
 */
export function buildPlan({ scope, config, effort, lenses, rules, log } = {}) {
  if (!scope || typeof scope !== 'object') throw configErrorFor('buildPlan requires a scope object');
  const { effort: resolvedEffort, lenses: resolvedLenses } = effectiveLenses({ effort, config, lenses });
  const explicitLenses =
    (Array.isArray(lenses) && lenses.length > 0) ||
    (Array.isArray(config?.review?.lenses) && config.review.lenses.length > 0);
  const planCfg = planConfig(config);
  const cwd = scope?.repo?.root || process.cwd();
  const mode = scope.mode ?? 'workspace';
  const modeLenses = lensesForMode(resolvedLenses, mode, explicitLenses);
  const range = scope.range ?? {};
  const ruleList = Array.isArray(rules) ? rules : [];

  const files = reviewableFiles(scope);
  const prepared = new Map();
  const ensurePrepared = (file) => {
    let value = prepared.get(file.path);
    if (!value) {
      const { patch, newLineCount } = computePatch({ cwd, mode, range, file });
      value = { path: file.path, patch, newLineCount };
      prepared.set(file.path, value);
    }
    return value;
  };

  // Prepare patches + line counts BEFORE grouping: the line budget must be
  // enforced on real newLineCount values, not placeholders.
  const sortedFiles = [...files].sort((a, b) => compareStrings(a.path, b.path));
  const preparedFiles = sortedFiles.map(ensurePrepared);

  const groups = [];
  if (planCfg.groupBy === 'perfile') {
    for (const file of preparedFiles) groups.push([file]);
  } else if (planCfg.groupBy === 'none') {
    if (preparedFiles.length > 0) groups.push(preparedFiles);
  } else {
    const buckets = new Map();
    for (const file of preparedFiles) {
      const key = bucketForPath(file.path);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(file);
    }
    for (const key of [...buckets.keys()].sort(compareStrings)) {
      const packed = packFiles(buckets.get(key), planCfg);
      for (const group of packed) groups.push(group);
    }
  }

  const finalGroups = expandSingleFileGroups(groups, { mode, config });
  const units = finalGroups.map((group, index) => {
    const unitFiles = group.map((file) => {
      const preparedFile = ensurePrepared(file);
      if (!file.__chunk) return preparedFile;
      return {
        ...preparedFile,
        patch: file.__chunk.patch,
        newLineCount: file.__chunk.newLineCount,
        chunk: {
          startLine: file.__chunk.startLine,
          endLine: file.__chunk.endLine,
          totalLines: preparedFile.newLineCount,
        },
      };
    });
    const changedLines = unitFiles.reduce((sum, file) => sum + (file.newLineCount || 0), 0);
    return {
      unitId: `u${String(index + 1).padStart(2, '0')}`,
      files: unitFiles,
      rules: unitRulesForFiles({ files: group, rules: ruleList, config }),
      lenses: [...modeLenses],
      stats: { changedLines, files: unitFiles.length },
    };
  });

  const skippedFiles = (Array.isArray(scope.files) ? scope.files : [])
    .filter((file) => file && !file.reviewable)
    .map((file) => ({ path: file.path, reason: file.excludeReason ?? 'unknown' }));

  const configuredRounds = Number.isInteger(config?.review?.rounds) && config.review.rounds > 0 ? config.review.rounds : DEFAULTS.review.rounds;
  const rounds = Math.max(configuredRounds, resolvedEffort === 'deep' ? 2 : 1);

  const plan = {
    schemaVersion: 1,
    runId: scope.runId ?? null,
    mode,
    effort: resolvedEffort,
    lenses: [...modeLenses],
    rounds,
    units,
    skippedFiles,
  };
  log?.('debug', 'plan built', { units: units.length, files: files.length, groupBy: planCfg.groupBy });
  return plan;
}
