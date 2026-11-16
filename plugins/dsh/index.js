/**
 * @local/dsh-code-review — DSH Host plugin half of dsh-code-reviewer.
 *
 * Wraps the deterministic review core (`../../lib/*.mjs`) as Host tools, a
 * `/review` human command, and two optional read-only HTTP routes. The core
 * modules are loaded lazily so the plugin can activate even when the engine
 * is not installed yet; tool calls then report ENGINE_UNAVAILABLE instead of
 * breaking plugin activation.
 *
 * No top-level I/O, no external dependencies, no DSH package imports.
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'code-review';
export const inject = ['tools', 'commands', 'llm'];

const PLUGIN_VERSION = '0.1.0';
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_RULES_DIR = fileURLToPath(new URL('../../rules/', import.meta.url));
const CORE_BASE = new URL('../../lib/', import.meta.url);

const MODES = ['workspace', 'staged', 'range', 'commit', 'scan'];
const EFFORTS = ['quick', 'standard', 'deep'];
const LENS_IDS = [
  'intent',
  'correctness',
  'errors',
  'concurrency',
  'data',
  'security',
  'contract',
  'tests',
  'scope',
  'history',
];
const FORMATS = ['all', 'md', 'json', 'sarif'];
const LEDGER_ACTIONS = ['list', 'show', 'latest'];

const DEFAULT_ROUTE = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' });
const DEFAULT_REASONING_EFFORT = 'max';

const RUN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_FILES = Object.freeze({
  scope: 'scope.json',
  plan: 'plan.json',
  rules: 'rules.json',
  reviews: 'reviews.json',
  aggregate: 'aggregate.json',
  findings: 'findings.json',
  gate: 'gate.json',
  reportMd: 'report.md',
  reportJson: 'report.json',
  reportSarif: 'report.sarif',
});
const REPORT_KEYS = Object.freeze({ md: 'reportMd', json: 'reportJson', sarif: 'reportSarif' });

const TOOL_TIMEOUTS = Object.freeze({
  scope: 5 * 60 * 1000,
  plan: 2 * 60 * 1000,
  run: 30 * 60 * 1000,
  gate: 20 * 60 * 1000,
  report: 2 * 60 * 1000,
  ledger: 60 * 1000,
});

const CORE_MODULES = Object.freeze({
  config: 'config.mjs',
  scope: 'scope.mjs',
  plan: 'plan.mjs',
  rules: 'rules.mjs',
  review: 'review.mjs',
  position: 'position.mjs',
  filter: 'filter.mjs',
  aggregate: 'aggregate.mjs',
  gate: 'gate.mjs',
  report: 'report.mjs',
  store: 'store.mjs',
});

const REQUIRED_CORE_FUNCTIONS = Object.freeze([
  ['config', 'loadConfig'],
  ['scope', 'createScope'],
  ['plan', 'buildPlan'],
  ['rules', 'loadRules'],
  ['review', 'runReview'],
  ['aggregate', 'aggregateFindings'],
  ['gate', 'runGate'],
  ['report', 'writeReports'],
  ['store', 'createRun'],
  ['store', 'writeJson'],
  ['store', 'readRun'],
  ['store', 'latestRun'],
  ['store', 'listRuns'],
  ['store', 'resolveRunDir'],
]);

/** Process-local runId -> {runDir, cwd, mode} cache, so scope/plan/run can target a repo other than the cwd. */
const KNOWN_RUNS = new Map();

/** One command invocation at a time; concurrent full reviews would double the model spend. */
let COMMAND_RUNNING = false;

/** Cached lazy import of the review engine. */
let corePromise = null;

/* -------------------------------------------------------------------------- */
/* Engine loading                                                             */
/* -------------------------------------------------------------------------- */

async function getCore() {
  if (!corePromise) {
    const pending = (async () => {
      const modules = {};
      const unimportable = [];
      for (const [key, file] of Object.entries(CORE_MODULES)) {
        try {
          modules[key] = await import(new URL(file, CORE_BASE).href);
        } catch {
          modules[key] = null;
          if (key !== 'position' && key !== 'filter') unimportable.push(`lib/${file}`);
        }
      }
      if (unimportable.length > 0) {
        throw pluginError(
          'ENGINE_UNAVAILABLE',
          `评审引擎无法加载，缺少或无法导入：${unimportable.join('、')}。请确认插件旁存在 dsh-code-reviewer 的 lib/ 目录。`,
        );
      }
      const absent = REQUIRED_CORE_FUNCTIONS.filter(([mod, fn]) => typeof modules[mod]?.[fn] !== 'function').map(
        ([mod, fn]) => `lib/${CORE_MODULES[mod]} >> ${fn}`,
      );
      if (absent.length > 0) {
        throw pluginError('ENGINE_UNAVAILABLE', `评审引擎接口不完整：${absent.join('；')}`);
      }
      return modules;
    })();
    corePromise = pending;
    pending.catch(() => {
      if (corePromise === pending) corePromise = null;
    });
  }
  return corePromise;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function pluginError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (isPlainObject(extra)) Object.assign(err, extra);
  return err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function intOr(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return undefined;
}

function finitePositive(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return undefined;
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/');
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Strip absolute paths and credential-looking fragments from any outward text. */
function sanitizeText(value, cwd) {
  let text = value == null ? '' : String(value);
  if (cwd) {
    const absolute = path.resolve(cwd);
    for (const variant of new Set([absolute, toPosixPath(absolute)])) {
      if (variant) text = text.split(variant).join('.');
    }
  }
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=***');
  return truncateText(text, 2000);
}

function errorPayload(err, cwd) {
  const code = typeof err?.code === 'string' && err.code ? err.code : 'INTERNAL';
  const message = sanitizeText(err?.message ?? String(err ?? '未知错误'), cwd);
  return { error: { code, message } };
}

/** Repo-relative POSIX display path; never leaks a drive letter outside the cwd. */
function relPathSafe(cwd, target) {
  const relative = path.relative(cwd, target);
  const posix = toPosixPath(relative);
  if (!posix || posix === '.') return '.';
  if (posix.startsWith('..')) return `<external>/${path.basename(target)}`;
  return posix;
}

function artifactsFor(cwd, runDir, keys = []) {
  const base = relPathSafe(cwd, runDir);
  const artifacts = { runDir: base };
  for (const key of keys) {
    const file = ARTIFACT_FILES[key];
    if (file) artifacts[key] = `${base}/${file}`;
  }
  return artifacts;
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function effectiveCwd(ctx) {
  try {
    const service = ctx?.get?.('workingDirectory');
    const dir = service?.defaultDirectory;
    if (typeof dir === 'string' && dir.trim()) return path.resolve(dir);
  } catch {
    /* fall through */
  }
  return path.resolve(process.cwd());
}

function targetCwd(ctx, repo) {
  const base = effectiveCwd(ctx);
  const value = cleanString(repo);
  return value ? path.resolve(base, value) : base;
}

function createLog(ctx) {
  let logger = null;
  try {
    logger = ctx?.logger;
  } catch {
    logger = null;
  }
  if (!logger) {
    try {
      logger = ctx?.get?.('logger');
    } catch {
      logger = null;
    }
  }
  return (level, message, extra) => {
    try {
      const text = sanitizeText(message == null ? '' : message);
      if (logger && typeof logger[level] === 'function') {
        logger[level](text, extra);
        return;
      }
      if (logger && typeof logger.log === 'function') {
        logger.log(text, extra);
        return;
      }
      if (typeof logger === 'function') logger(level, text, extra);
    } catch {
      /* logging must never break a review */
    }
  };
}

function throwIfAborted(signal, cwd) {
  if (signal && signal.aborted) {
    throw pluginError('ABORTED', `操作已取消${cwd ? `（${sanitizeText(cwd)}）` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Config layering                                                            */
/* -------------------------------------------------------------------------- */

const CONFIG_SECTIONS = ['model', 'scope', 'plan', 'review', 'rules', 'gate', 'hooks', 'report'];

/** Only contract config sections from the plugin row become overrides. */
function configOverridesOf(pluginConfig) {
  const overrides = {};
  if (!isPlainObject(pluginConfig)) return overrides;
  for (const section of CONFIG_SECTIONS) {
    if (isPlainObject(pluginConfig[section])) overrides[section] = { ...pluginConfig[section] };
  }
  if (Number.isFinite(pluginConfig.schemaVersion)) overrides.schemaVersion = pluginConfig.schemaVersion;
  return overrides;
}

function mergeOverrides(base, extra) {
  if (!isPlainObject(extra)) return isPlainObject(base) ? { ...base } : {};
  const merged = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) merged[key] = { ...merged[key], ...value };
    else merged[key] = isPlainObject(value) ? { ...value } : value;
  }
  return merged;
}

async function loadEffectiveConfig(core, cwd, pluginConfig, toolOverrides) {
  const overrides = mergeOverrides(configOverridesOf(pluginConfig), toolOverrides);
  try {
    const config = core.config.loadConfig({ cwd, overrides });
    return isPlainObject(config) ? config : {};
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('CONFIG', `加载评审配置失败：${sanitizeText(err?.message, cwd)}`);
  }
}

async function resolveBuiltinRulesDir() {
  for (const dir of [REPO_RULES_DIR, path.join(PLUGIN_DIR, 'rules')]) {
    if (await isDirectory(dir)) return dir;
  }
  return undefined;
}

async function loadRulesFor(core, cwd, config, log) {
  const builtinDir = await resolveBuiltinRulesDir();
  try {
    return core.rules.loadRules({ cwd, config, builtinDir });
  } catch (err) {
    log('warn', `加载规则失败：${sanitizeText(err?.message, cwd)}`);
    if (builtinDir) {
      try {
        return core.rules.loadRules({ cwd, config, builtinDir: undefined });
      } catch {
        /* rethrow the original error below */
      }
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Reference validation                                                       */
/* -------------------------------------------------------------------------- */

function normalizeMode(value) {
  const mode = cleanString(value);
  if (!mode) return undefined;
  const normalized = mode.toLowerCase();
  if (!MODES.includes(normalized)) {
    throw pluginError('USAGE', `无效的 mode：${truncateText(sanitizeText(mode), 80)}；可选 ${MODES.join(' / ')}`);
  }
  return normalized;
}

function normalizeEffort(value) {
  const effort = cleanString(value);
  if (!effort) return undefined;
  const normalized = effort.toLowerCase();
  if (!EFFORTS.includes(normalized)) {
    throw pluginError('USAGE', `无效的 effort：${truncateText(sanitizeText(effort), 80)}；可选 ${EFFORTS.join(' / ')}`);
  }
  return normalized;
}

function normalizeLenses(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw pluginError('USAGE', 'lenses 必须是视角 id 数组');
  const lenses = [];
  for (const item of value) {
    const lens = cleanString(typeof item === 'string' ? item : undefined)?.toLowerCase();
    if (!lens || !LENS_IDS.includes(lens)) {
      throw pluginError('USAGE', `无效的视角：${truncateText(sanitizeText(String(item)), 80)}；可选 ${LENS_IDS.join(' / ')}`);
    }
    if (!lenses.includes(lens)) lenses.push(lens);
  }
  return lenses.length > 0 ? lenses : undefined;
}

function normalizeRounds(value) {
  if (value == null) return undefined;
  const rounds = Number(value);
  if (!Number.isFinite(rounds) || rounds < 1 || rounds > 3) {
    throw pluginError('USAGE', 'rounds 必须是 1 到 3 之间的整数');
  }
  return Math.trunc(rounds);
}

function normalizeFormat(value) {
  const format = cleanString(value)?.toLowerCase();
  if (!format) return 'all';
  if (!FORMATS.includes(format)) {
    throw pluginError('USAGE', `无效的 format：${truncateText(sanitizeText(format), 80)}；可选 ${FORMATS.join(' / ')}`);
  }
  return format;
}

function normalizeLedgerAction(value) {
  const action = cleanString(value)?.toLowerCase() ?? 'list';
  if (!LEDGER_ACTIONS.includes(action)) {
    throw pluginError('USAGE', `无效的 action：${truncateText(sanitizeText(action), 80)}；可选 ${LEDGER_ACTIONS.join(' / ')}`);
  }
  return action;
}

function normalizeRunRef(value) {
  if (value == null) return 'latest';
  const ref = cleanString(value);
  if (!ref || ref.toLowerCase() === 'latest') return 'latest';
  if (!RUN_REF_RE.test(ref) || ref.includes('..')) {
    throw pluginError('USAGE', `无效的 runId：${truncateText(sanitizeText(ref), 120)}`);
  }
  return ref;
}

/* -------------------------------------------------------------------------- */
/* Run context                                                                */
/* -------------------------------------------------------------------------- */

async function safeListRuns(core, cwd, config, log) {
  try {
    const runs = await core.store.listRuns(cwd, config);
    return Array.isArray(runs) ? runs.filter(isPlainObject) : [];
  } catch (err) {
    log('warn', `读取历史运行失败：${sanitizeText(err?.message, cwd)}`);
    return [];
  }
}

async function resolveRunContext(env, runIdInput, toolOverrides = {}) {
  const core = await getCore();
  const baseCwd = effectiveCwd(env.ctx);
  let config = await loadEffectiveConfig(core, baseCwd, env.pluginConfig, toolOverrides);
  const ref = normalizeRunRef(runIdInput);

  let info = null;
  if (ref !== 'latest') {
    const cached = KNOWN_RUNS.get(ref);
    if (cached && cached.runDir && (await pathExists(cached.runDir))) {
      info = { runId: ref, runDir: cached.runDir, cwd: cached.cwd ?? baseCwd };
    } else {
      let resolved = null;
      try {
        resolved = await core.store.resolveRunDir(baseCwd, config, ref);
      } catch {
        resolved = null;
      }
      if (resolved && (await pathExists(resolved))) {
        info = { runId: ref, runDir: resolved, cwd: baseCwd };
      } else {
        const runs = await safeListRuns(core, baseCwd, config, env.log);
        const hit = runs.find((run) => run.runId === ref);
        if (hit?.runDir && (await pathExists(hit.runDir))) {
          info = { runId: ref, runDir: hit.runDir, cwd: baseCwd };
        }
      }
    }
    if (!info) {
      throw pluginError('USAGE', `找不到评审运行 ${truncateText(sanitizeText(ref), 120)}；请先在对应仓库调用 review_scope，或在正确的工作目录下调用。`);
    }
  } else {
    let resolved = null;
    try {
      resolved = await core.store.latestRun(baseCwd, config);
    } catch {
      resolved = null;
    }
    if (resolved && (await pathExists(resolved))) {
      info = { runId: path.basename(resolved), runDir: resolved, cwd: baseCwd };
    } else {
      const runs = await safeListRuns(core, baseCwd, config, env.log);
      if (runs.length > 0 && runs[0].runDir) info = { runId: runs[0].runId, runDir: runs[0].runDir, cwd: baseCwd };
    }
    if (!info) throw pluginError('USAGE', '还没有任何评审运行；请先调用 review_scope 创建一次评审。');
  }

  if (info.cwd && path.resolve(info.cwd) !== path.resolve(baseCwd)) {
    config = await loadEffectiveConfig(core, info.cwd, env.pluginConfig, toolOverrides);
  }

  let run = null;
  try {
    run = await core.store.readRun(info.runDir);
  } catch (err) {
    env.log('warn', `读取运行 ${info.runId} 失败：${sanitizeText(err?.message, info.cwd)}`);
  }
  const record = isPlainObject(run) ? run : {};
  const runId = cleanString(record.runId) ?? cleanString(record.meta?.runId) ?? info.runId ?? path.basename(info.runDir);
  const cwd = info.cwd ?? baseCwd;
  // A run is a reproducible snapshot: settings stored in meta.json win over later repo edits.
  // Tool-level overrides (effort/lenses/rounds) still apply on top of that snapshot.
  const snapshot = record.meta?.config;
  if (isPlainObject(snapshot) && Object.keys(snapshot).length > 0 && typeof core.config.deepMerge === 'function') {
    try {
      config = mergeOverrides(core.config.deepMerge(config, snapshot), toolOverrides);
    } catch (err) {
      env.log('warn', `合并运行配置快照失败，继续使用当前配置：${sanitizeText(err?.message, cwd)}`);
    }
  }
  KNOWN_RUNS.set(runId, { runDir: info.runDir, cwd, mode: record.meta?.mode ?? record.scope?.mode });
  return { core, runId, runDir: info.runDir, cwd, config, run: record };
}

/* -------------------------------------------------------------------------- */
/* Pipeline stages                                                            */
/* -------------------------------------------------------------------------- */

async function writeJsonArtifact(core, runDir, name, value) {
  return core.store.writeJson(runDir, name, value);
}

async function createScopeAndRun(env, { core, cwd, config, mode, base, head, scanPath }) {
  let scope;
  try {
    scope = core.scope.createScope({
      cwd,
      config,
      mode,
      base,
      head,
      commit: mode === 'commit' ? head : undefined,
      path: scanPath,
    });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('GIT', `生成评审范围失败：${sanitizeText(err?.message, cwd)}`);
  }
  if (!isPlainObject(scope)) throw pluginError('SCHEMA', '生成评审范围失败：createScope 未返回 scope 对象');

  let created;
  try {
    created = core.store.createRun({ cwd, config, mode: scope.mode ?? mode, scope });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('SCHEMA', `创建运行失败：${sanitizeText(err?.message, cwd)}`);
  }
  const runId = cleanString(scope.runId) ?? cleanString(created?.runId);
  const runDir = cleanString(created?.runDir);
  if (!runId || !runDir) throw pluginError('SCHEMA', '创建运行失败：store.createRun 未返回 runId/runDir');

  scope.runId = runId;
  await writeJsonArtifact(core, runDir, 'scope', scope);
  KNOWN_RUNS.set(runId, { runDir, cwd, mode: scope.mode ?? mode });
  return { scope, runId, runDir };
}

async function buildPlanFor(env, { core, cwd, config, scope, effort, lenses, rules: providedRules, runId, runDir }) {
  const rules = Array.isArray(providedRules) ? providedRules : await loadRulesFor(core, cwd, config, env.log);
  let plan;
  try {
    plan = core.plan.buildPlan({ scope, config, effort, lenses, rules });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('SCHEMA', `生成评审计划失败：${sanitizeText(err?.message, cwd)}`);
  }
  if (!isPlainObject(plan)) throw pluginError('SCHEMA', '生成评审计划失败：buildPlan 未返回 plan 对象');
  plan.runId = cleanString(plan.runId) ?? runId;
  await writeJsonArtifact(core, runDir, 'plan', plan);
  if (Array.isArray(rules)) await writeJsonArtifact(core, runDir, 'rules', { schemaVersion: 1, runId, rules });
  return { plan, rules };
}

function countsFromFindings(findings) {
  const counts = { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 };
  for (const finding of Array.isArray(findings) ? findings : []) {
    const severity = String(finding?.severity ?? '');
    if (severity === 'blocker') counts.blocker += 1;
    else if (severity === 'major') counts.major += 1;
    else if (severity === 'minor') counts.minor += 1;
    if (finding?.status === 'needs-human' || finding?.needsHuman === true) counts.needsHuman += 1;
    if (finding?.status === 'dropped') counts.dropped += 1;
  }
  return counts;
}

function emptyAggregate() {
  return {
    schemaVersion: 1,
    findings: [],
    counts: { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 },
    verdict: 'pass',
    blocking: [],
    humanAttention: [],
    errors: [],
  };
}

function findingsRecord(runId, aggregate) {
  return {
    schemaVersion: 1,
    runId,
    verdict: aggregate.verdict ?? 'pass',
    counts: aggregate.counts ?? { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 },
    findings: Array.isArray(aggregate.findings) ? aggregate.findings : [],
    blocking: Array.isArray(aggregate.blocking) ? aggregate.blocking : [],
    humanAttention: Array.isArray(aggregate.humanAttention) ? aggregate.humanAttention : [],
    errors: Array.isArray(aggregate.errors) ? aggregate.errors : [],
    stats: aggregate.stats ?? null,
  };
}

function addTokenUsage(target, source) {
  if (!isPlainObject(target)) target = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!isPlainObject(source)) return target;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    target[key] = intOr(target[key]) + intOr(source[key]);
  }
  return target;
}

function tokenUsageOnly(usage) {
  const raw = isPlainObject(usage) ? usage : {};
  return {
    inputTokens: intOr(raw.inputTokens),
    outputTokens: intOr(raw.outputTokens),
    cacheReadTokens: intOr(raw.cacheReadTokens),
    cacheWriteTokens: intOr(raw.cacheWriteTokens),
  };
}

async function applyFilterPass(core, { anchored, units, config, llm, log }) {
  const groups = new Map();
  for (const finding of anchored) {
    const key = finding.unitId ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(finding);
    else groups.set(key, [finding]);
  }
  const kept = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const [unitId, findings] of groups) {
    const unit = units.get(unitId);
    if (!unit || findings.length === 0) {
      kept.push(...findings);
      continue;
    }
    try {
      const result = await core.filter.filterFindings({ unit, findings, llm, config });
      if (isPlainObject(result?.usage)) addTokenUsage(usage, result.usage);
      const filtered = Array.isArray(result?.findings) ? result.findings.filter(isPlainObject) : null;
      if (!filtered) {
        kept.push(...findings);
        continue;
      }
      for (const finding of filtered) {
        kept.push({ ...finding, lens: finding.lens ?? findings[0].lens, unitId: finding.unitId ?? unitId });
      }
    } catch (err) {
      log('warn', `假阳性过滤失败（${unitId}），保留全部 findings：${sanitizeText(err?.message)}`);
      kept.push(...findings);
    }
  }
  return { anchored: kept, usage };
}

async function finalizeFindings(core, { review, plan, config, llm, log }) {
  const units = new Map();
  for (const unit of Array.isArray(plan?.units) ? plan.units : []) {
    if (unit?.unitId) units.set(unit.unitId, unit);
  }
  const anchorFindings = typeof core.position?.anchorFindings === 'function' ? core.position.anchorFindings : null;
  const reviews = Array.isArray(review?.reviews) ? review.reviews : [];
  let anchored = [];

  for (const entry of reviews) {
    if (!isPlainObject(entry) || entry.error) continue;
    const unit = units.get(entry.unitId);
    let findings = Array.isArray(entry.findings) ? entry.findings.filter(isPlainObject) : [];
    if (findings.length > 0 && unit && anchorFindings) {
      try {
        const anchoredResult = anchorFindings(findings, unit);
        if (Array.isArray(anchoredResult)) findings = anchoredResult.filter(isPlainObject);
      } catch (err) {
        log('warn', `行号定位失败（${entry.unitId}/${entry.lens}）：${sanitizeText(err?.message)}`);
      }
    }
    for (const finding of findings) {
      anchored.push({ ...finding, lens: entry.lens, unitId: entry.unitId });
    }
  }

  let filterUsage = null;
  if (config?.review?.filter !== false && typeof core.filter?.filterFindings === 'function') {
    const filtered = await applyFilterPass(core, { anchored, units, config, llm, log });
    anchored = filtered.anchored;
    filterUsage = filtered.usage;
  }

  let aggregate;
  try {
    aggregate = core.aggregate.aggregateFindings({ reviews, anchored, config });
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    aggregate = core.aggregate.aggregateFindings({ reviews, config });
  }
  if (!isPlainObject(aggregate)) throw pluginError('SCHEMA', '聚合评审结果失败：aggregateFindings 未返回结果');
  if (!Array.isArray(aggregate.findings)) aggregate.findings = [];
  if (!isPlainObject(aggregate.counts)) aggregate.counts = countsFromFindings(aggregate.findings);
  return { anchored, aggregate, filterUsage };
}

async function performReview(env, { core, cwd, config, scope, plan, runId, runDir, signal }) {
  throwIfAborted(signal, cwd);
  const route = resolveModelRoute(env.ctx, config, env.pluginConfig);
  const llm = createHostLlm(env.ctx, route, env.log);
  let review;
  try {
    review = await core.review.runReview({ scope, plan, config, llm, cwd, log: env.log, signal });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('LLM', `评审执行失败：${sanitizeText(err?.message, cwd)}`);
  }
  if (!isPlainObject(review)) throw pluginError('SCHEMA', '评审执行失败：runReview 未返回结果');

  const { anchored, aggregate, filterUsage } = await finalizeFindings(core, { review, plan, config, llm, log: env.log });
  const reviewTokenUsage = addTokenUsage(tokenUsageOnly(review.usage), filterUsage);
  const usage = normalizeUsage(reviewTokenUsage, llm.usageSummary(), review.durationMs);
  const reviewRecord = {
    schemaVersion: 1,
    runId,
    rounds: review.rounds ?? config?.review?.rounds ?? 1,
    reviews: Array.isArray(review.reviews) ? review.reviews : [],
    usage: reviewTokenUsage,
    calls: intOr(review.calls),
    durationMs: intOr(review.durationMs),
    startedAt: review.startedAt ?? null,
    finishedAt: review.finishedAt ?? null,
    anchored,
  };
  await writeJsonArtifact(core, runDir, 'reviews', reviewRecord);
  await writeJsonArtifact(core, runDir, 'aggregate', aggregate);
  await writeJsonArtifact(core, runDir, 'findings', findingsRecord(runId, aggregate));
  return { review, reviewRecord, anchored, aggregate, usage, route };
}

async function performGate(core, { cwd, config, aggregate, runDir, log }) {
  let gate;
  try {
    gate = await core.gate.runGate({ cwd, config, aggregate, runDir, log });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('GATE', `门禁执行失败：${sanitizeText(err?.message, cwd)}`);
  }
  if (!isPlainObject(gate)) throw pluginError('GATE', '门禁执行失败：runGate 未返回结果');
  return gate;
}

function normalizeReportPaths(paths, runDir) {
  const out = {};
  if (isPlainObject(paths)) {
    for (const key of ['md', 'json', 'sarif']) {
      const value = cleanString(paths[key]);
      if (value) out[key] = value;
    }
  }
  for (const [key, name] of Object.entries({ md: 'report.md', json: 'report.json', sarif: 'report.sarif' })) {
    if (!out[key]) out[key] = path.join(runDir, name);
  }
  return out;
}

async function performReport(core, { runDir, scope, plan, aggregate, gate, meta, cwd, log }) {
  if (!isPlainObject(aggregate)) throw pluginError('USAGE', '缺少聚合结果；请先运行 review_run。');
  let paths;
  try {
    paths = await core.report.writeReports({ runDir, scope, plan, aggregate, gate, meta });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code) throw err;
    throw pluginError('SCHEMA', `生成报告失败：${sanitizeText(err?.message, cwd ?? runDir)}`);
  }
  return normalizeReportPaths(paths, runDir);
}

function reportMeta({ runId, reviewRecord, route, aggregate }) {
  return {
    runId,
    generatedAt: new Date().toISOString(),
    version: PLUGIN_VERSION,
    tool: 'dsh-code-review',
    usage: reviewRecord?.usage ?? null,
    calls: reviewRecord?.calls ?? null,
    durationMs: reviewRecord?.durationMs ?? null,
    startedAt: reviewRecord?.startedAt ?? null,
    finishedAt: reviewRecord?.finishedAt ?? null,
    model: route
      ? { transport: 'dsh', provider: route.provider ?? null, model: route.model ?? null, effort: route.reasoningEffort ?? null }
      : null,
    errors: Array.isArray(aggregate?.errors) ? aggregate.errors : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Counts / verdict normalization                                             */
/* -------------------------------------------------------------------------- */

function scopeCounts(scope) {
  const raw = isPlainObject(scope?.counts) ? scope.counts : {};
  return {
    total: intOr(raw.total),
    reviewable: intOr(raw.reviewable),
    excluded: intOr(raw.excluded),
    insertions: intOr(raw.insertions),
    deletions: intOr(raw.deletions),
  };
}

function findingCounts(aggregate) {
  const raw = isPlainObject(aggregate?.counts) ? aggregate.counts : countsFromFindings(aggregate?.findings);
  return {
    blocker: intOr(raw.blocker),
    major: intOr(raw.major),
    minor: intOr(raw.minor),
    needsHuman: intOr(raw.needsHuman ?? raw['needs-human']),
    dropped: intOr(raw.dropped),
  };
}

function normalizeVerdict(value) {
  const verdict = String(value ?? '');
  if (verdict === 'pass' || verdict === 'block' || verdict === 'needs-human') return verdict;
  if (verdict === 'fail') return 'block';
  return 'needs-human';
}

function normalizeGateVerdict(value) {
  const verdict = String(value ?? '');
  if (verdict === 'pass' || verdict === 'fail' || verdict === 'needs-human' || verdict === 'error') return verdict;
  return 'error';
}

function exitCodeForVerdict(verdict) {
  if (verdict === 'pass') return 0;
  if (verdict === 'needs-human') return 3;
  return 2;
}

function exitCodeForGate(gate, aggregate) {
  const verdict = normalizeGateVerdict(gate?.verdict);
  if (Number.isFinite(gate?.exitCode)) return Math.trunc(gate.exitCode);
  if (verdict === 'pass') return 0;
  if (verdict === 'needs-human') return 3;
  if (verdict === 'error') return 5;
  const failedRequired = (Array.isArray(gate?.checks) ? gate.checks : []).some(
    (check) => check?.required !== false && check?.skipped !== true && Number(check?.exit) !== 0,
  );
  if (failedRequired) return 4;
  const blocking = Array.isArray(gate?.blocking) ? gate.blocking : Array.isArray(aggregate?.blocking) ? aggregate.blocking : [];
  return blocking.length > 0 ? 2 : 0;
}

function normalizeUsage(primary, fallback, durationMs) {
  const source = isPlainObject(primary) ? primary : {};
  const backup = isPlainObject(fallback) ? fallback : {};
  const read = (key) => intOr(source[key] ?? backup[key]);
  return {
    inputTokens: read('inputTokens'),
    outputTokens: read('outputTokens'),
    cacheReadTokens: read('cacheReadTokens'),
    cacheWriteTokens: read('cacheWriteTokens'),
    calls: read('calls'),
    durationMs: intOr(source.durationMs ?? backup.durationMs ?? durationMs),
  };
}

/* -------------------------------------------------------------------------- */
/* Compact views                                                              */
/* -------------------------------------------------------------------------- */

function compactScopeFiles(files) {
  const all = Array.isArray(files) ? files : [];
  const limit = 40;
  const items = all.slice(0, limit).map((file) => ({
    path: file?.path ?? '',
    status: file?.status ?? '',
    reviewable: file?.reviewable === true,
    excludeReason: file?.excludeReason ?? '',
    insertions: intOr(file?.insertions),
    deletions: intOr(file?.deletions),
  }));
  return { files: items, total: all.length, truncated: all.length > limit };
}

function compactUnits(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const limit = 30;
  const items = units.slice(0, limit).map((unit) => ({
    unitId: unit?.unitId ?? '',
    files: (Array.isArray(unit?.files) ? unit.files : []).map((file) => file?.path ?? ''),
    lenses: Array.isArray(unit?.lenses) ? unit.lenses : [],
    ruleCount: Array.isArray(unit?.rules) ? unit.rules.length : 0,
    changedLines: intOr(unit?.stats?.changedLines),
  }));
  return { units: items, total: units.length, truncated: units.length > limit };
}

function compactBlocking(blocking) {
  const all = Array.isArray(blocking) ? blocking : [];
  const limit = 20;
  const items = all.slice(0, limit).map((item) => ({
    fingerprint: item?.fingerprint ?? null,
    file: item?.file ?? '',
    startLine: Number.isFinite(item?.startLine) ? item.startLine : null,
    severity: item?.severity ?? '',
    title: truncateText(sanitizeText(item?.title ?? item?.problem ?? ''), 200),
  }));
  return { blocking: items, total: all.length, truncated: all.length > limit };
}

function compactChecks(checks) {
  const all = Array.isArray(checks) ? checks : [];
  const limit = 20;
  return all.slice(0, limit).map((check) => ({
    id: check?.id ?? '',
    cmd: truncateText(sanitizeText(check?.cmd ?? ''), 200),
    exit: Number.isFinite(check?.exit) ? check.exit : null,
    durationMs: intOr(check?.durationMs),
    required: check?.required !== false,
    skipped: check?.skipped === true,
    timedOut: check?.timedOut === true,
    stdoutTail: truncateText(sanitizeText(check?.stdoutTail ?? ''), 400),
  }));
}

function topFindings(aggregate, limit = 10) {
  const findings = (Array.isArray(aggregate?.findings) ? aggregate.findings : []).filter(
    (finding) => finding?.status !== 'dropped',
  );
  const rank = { blocker: 0, major: 1, minor: 2 };
  findings.sort((a, b) => (rank[a?.severity] ?? 3) - (rank[b?.severity] ?? 3));
  return {
    findings: findings.slice(0, limit).map((finding) => ({
      fingerprint: finding?.fingerprint ?? null,
      file: finding?.file ?? '',
      startLine: Number.isFinite(finding?.startLine) ? finding.startLine : null,
      endLine: Number.isFinite(finding?.endLine) ? finding.endLine : null,
      category: finding?.category ?? '',
      severity: finding?.severity ?? '',
      status: finding?.status ?? '',
      votes: intOr(finding?.votes),
      problem: truncateText(sanitizeText(finding?.problem ?? finding?.title ?? ''), 240),
    })),
    total: findings.length,
    truncated: findings.length > limit,
  };
}

/* -------------------------------------------------------------------------- */
/* Host LLM adapter                                                           */
/* -------------------------------------------------------------------------- */

function safeService(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/** Prefer the directly injected service (`ctx.llm`) and fall back to `ctx.get('llm')`. */
function llmServiceOf(ctx) {
  try {
    if (ctx?.llm && typeof ctx.llm.stream === 'function') return ctx.llm;
  } catch {
    /* fall through */
  }
  const service = safeService(ctx, 'llm');
  return service && typeof service.stream === 'function' ? service : null;
}

function resolveModelRoute(ctx, config, pluginConfig) {
  const pluginModel = isPlainObject(pluginConfig?.model) ? pluginConfig.model : {};
  const configModel = isPlainObject(config?.model) ? config.model : {};
  let selection = null;
  try {
    const service = safeService(ctx, 'agentDefaultModel');
    const current = service?.currentSelection?.();
    if (isPlainObject(current) && typeof current.provider === 'string' && typeof current.model === 'string') {
      selection = current;
    }
  } catch {
    selection = null;
  }
  // A repo config's default model id ("deepseek-flash") must not override the session model;
  // only an explicitly different repo model is treated as a route choice.
  const explicitRepoModel = configModel.model && configModel.model !== DEFAULT_ROUTE.model ? configModel.model : undefined;
  const provider = firstString(pluginModel.provider, configModel.provider, selection?.provider, DEFAULT_ROUTE.provider);
  const model = firstString(pluginModel.model, explicitRepoModel, selection?.model, DEFAULT_ROUTE.model);
  const reasoningEffort = firstString(pluginModel.reasoningEffort, configModel.reasoningEffort, DEFAULT_REASONING_EFFORT);
  return {
    provider,
    model,
    reasoningEffort,
    maxTokens: finitePositive(pluginModel.maxTokens) ?? finitePositive(configModel.maxTokens),
    temperature: typeof pluginModel.temperature === 'number' && Number.isFinite(pluginModel.temperature) ? pluginModel.temperature : undefined,
  };
}

function normalizeTokenUsage(usage) {
  const raw = isPlainObject(usage) ? usage : {};
  return {
    inputTokens: intOr(raw.inputTokens),
    outputTokens: intOr(raw.outputTokens),
    cacheReadTokens: intOr(raw.cacheReadTokens),
    cacheWriteTokens: intOr(raw.cacheWriteTokens),
  };
}

function classifyLlmFailure(failure) {
  const status = Number(failure?.status);
  if (status === 401 || status === 403) return 'LLM_AUTH';
  if (status === 429) return 'LLM_RATE_LIMIT';
  if (status === 408 || status === 504) return 'LLM_TIMEOUT';
  if (Number.isFinite(status) && status >= 500) return 'LLM_SERVER';
  const code = String(failure?.code ?? '').toLowerCase();
  if (/abort|cancel/.test(code)) return 'ABORTED';
  if (/auth|unauthor|api.?key|forbidden|invalid.?key|credential/.test(code)) return 'LLM_AUTH';
  if (/rate|quota|too.?many/.test(code)) return 'LLM_RATE_LIMIT';
  if (/timeout|timed.?out/.test(code)) return 'LLM_TIMEOUT';
  if (/server|unavailable|overload|upstream/.test(code)) return 'LLM_SERVER';
  return 'LLM';
}

function mapLlmFailure(failure, signal) {
  if (signal && signal.aborted) return pluginError('ABORTED', '模型调用已取消');
  const code = classifyLlmFailure(failure);
  const message = sanitizeText(failure?.message ?? '模型调用失败');
  return pluginError(code, message, { llmCode: failure?.code, status: failure?.status });
}

/**
 * Adapt `ctx.llm.stream` to the engine's `llm.complete(req)` interface.
 * Returns {text, usage, stopReason, model, effort}; errors keep LLM_* codes.
 */
function createHostLlm(ctx, route, log) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, durationMs: 0 };

  async function complete(req = {}) {
    const service = llmServiceOf(ctx);
    if (!service) {
      throw pluginError('LLM', '当前 Host 未提供 llm 服务，无法执行模型评审');
    }
    const startedAt = Date.now();
    const user = typeof req?.user === 'string' ? req.user : String(req?.user ?? '');
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    };
    if (typeof req?.system === 'string' && req.system) options.system = req.system;
    const maxTokens = finitePositive(req?.maxTokens) ?? route.maxTokens;
    if (maxTokens) options.maxTokens = maxTokens;
    if (typeof req?.temperature === 'number' && Number.isFinite(req.temperature)) options.temperature = req.temperature;
    else if (typeof route.temperature === 'number') options.temperature = route.temperature;
    if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort;
    if (req?.signal) options.signal = req.signal;

    let text = '';
    let lastUsage = null;
    let stopReason = 'stop';
    totals.calls += 1;
    try {
      const stream = service.stream(options);
      for await (const chunk of stream) {
        if (!isPlainObject(chunk)) continue;
        switch (chunk.type) {
          case 'text-delta':
            if (typeof chunk.text === 'string') text += chunk.text;
            break;
          case 'usage':
            if (isPlainObject(chunk.usage)) lastUsage = chunk.usage;
            break;
          case 'finish': {
            const reason = chunk.reason;
            const kind = String(reason?.kind ?? 'stop');
            stopReason = kind;
            if (kind === 'error') throw mapLlmFailure(reason?.failure, req?.signal);
            if (kind === 'aborted') throw mapLlmFailure(reason?.failure, req?.signal);
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      if (typeof err?.code === 'string' && err.code) throw err;
      if (req?.signal?.aborted) throw pluginError('ABORTED', '模型调用已取消');
      const code = classifyLlmFailure({ code: err?.code, status: err?.status });
      throw pluginError(code === 'LLM' ? 'LLM' : code, sanitizeText(err?.message ?? '模型调用失败'));
    }

    const usage = normalizeTokenUsage(lastUsage);
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      totals[key] += usage[key];
    }
    totals.durationMs += Date.now() - startedAt;
    return {
      text,
      usage,
      stopReason,
      model: route.model,
      effort: route.reasoningEffort,
    };
  }

  return {
    complete,
    describe() {
      return {
        transport: 'dsh',
        provider: route.provider,
        model: route.model,
        effort: route.reasoningEffort,
      };
    },
    usageSummary() {
      return { ...totals };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tool stages                                                                */
/* -------------------------------------------------------------------------- */

async function executeReviewScope(args, exec, env) {
  const core = await getCore();
  const cwd = targetCwd(env.ctx, args?.repo);
  if (!(await pathExists(cwd))) {
    throw pluginError('USAGE', `目标目录不存在：${truncateText(sanitizeText(String(args?.repo ?? cwd), cwd), 200)}`);
  }
  const requestedMode = normalizeMode(args?.mode);
  const gitDir = await pathExists(path.join(cwd, '.git'));
  const mode = requestedMode ?? (gitDir ? 'workspace' : 'scan');
  let scanPath;
  if (mode === 'scan') {
    const requestedPath = cleanString(args?.path);
    scanPath = requestedPath ? path.resolve(cwd, requestedPath) : cwd;
    if (!(await pathExists(scanPath))) {
      throw pluginError('USAGE', `扫描目录不存在：${truncateText(sanitizeText(String(args?.path), cwd), 200)}`);
    }
  }
  const config = await loadEffectiveConfig(core, cwd, env.pluginConfig, {});
  const head = cleanString(args?.head);
  const { scope, runId, runDir } = await createScopeAndRun(env, {
    core,
    cwd,
    config,
    mode,
    base: cleanString(args?.base),
    head,
    scanPath,
  });
  const counts = scopeCounts(scope);
  const files = compactScopeFiles(scope.files);
  const rawCoverage = isPlainObject(scope.coverage) ? scope.coverage : {};
  const unreviewed = Array.isArray(rawCoverage.unreviewed) ? rawCoverage.unreviewed : [];
  const coverage = {
    complete: rawCoverage.complete === true,
    unreviewed: unreviewed.slice(0, 40),
    unreviewedTotal: unreviewed.length,
    truncated: unreviewed.length > 40,
  };
  return {
    runId,
    mode: scope.mode ?? mode,
    counts,
    files: files.files,
    fileCount: files.total,
    truncated: files.truncated,
    coverage,
    artifacts: artifactsFor(cwd, runDir, ['scope']),
    summary: `${scope.mode ?? mode} 模式生成评审范围：${counts.total} 个文件（可评审 ${counts.reviewable}、排除 ${counts.excluded}），run ${runId}`,
  };
}

async function executeReviewPlan(args, exec, env) {
  const effort = normalizeEffort(args?.effort);
  const overrides = effort ? { review: { effort } } : {};
  const rc = await resolveRunContext(env, args?.runId, overrides);
  if (!isPlainObject(rc.run.scope)) {
    throw pluginError('USAGE', `运行 ${rc.runId} 还没有 scope.json；请先调用 review_scope。`);
  }
  const effectiveEffort = effort ?? cleanString(rc.config?.review?.effort);
  const storedRules = Array.isArray(rc.run.rules?.rules) ? rc.run.rules.rules : undefined;
  const { plan } = await buildPlanFor(env, {
    core: rc.core,
    cwd: rc.cwd,
    config: rc.config,
    scope: rc.run.scope,
    effort: effectiveEffort,
    rules: storedRules,
    runId: rc.runId,
    runDir: rc.runDir,
  });
  const units = compactUnits(plan);
  const fileCount = (Array.isArray(plan.units) ? plan.units : []).reduce(
    (total, unit) => total + (Array.isArray(unit?.files) ? unit.files.length : 0),
    0,
  );
  const skipped = Array.isArray(plan.skippedFiles) ? plan.skippedFiles.length : 0;
  return {
    runId: rc.runId,
    effort: plan.effort ?? effectiveEffort ?? null,
    lenses: Array.isArray(plan.lenses) ? plan.lenses : [],
    units: units.units,
    unitCount: units.total,
    fileCount,
    skippedFileCount: skipped,
    truncated: units.truncated,
    artifacts: artifactsFor(rc.cwd, rc.runDir, ['scope', 'plan', 'rules']),
    summary: `评审计划：${units.total} 个单元 / ${fileCount} 个文件，effort ${plan.effort ?? effectiveEffort ?? 'standard'}，${skipped} 个文件被跳过，run ${rc.runId}`,
  };
}

async function executeReviewRun(args, exec, env) {
  const effort = normalizeEffort(args?.effort);
  const lenses = normalizeLenses(args?.lenses);
  const rounds = normalizeRounds(args?.rounds);
  const reviewOverrides = {};
  if (effort) reviewOverrides.effort = effort;
  if (lenses) reviewOverrides.lenses = lenses;
  if (rounds) reviewOverrides.rounds = rounds;
  const rc = await resolveRunContext(env, args?.runId, Object.keys(reviewOverrides).length > 0 ? { review: reviewOverrides } : {});
  if (!isPlainObject(rc.run.scope)) {
    throw pluginError('USAGE', `运行 ${rc.runId} 还没有 scope.json；请先调用 review_scope。`);
  }
  // 与 CLI 一致：缺少计划或显式覆盖 effort/lenses 时重算计划（runReview 以 plan.lenses 为准）。
  let plan = isPlainObject(rc.run.plan) ? rc.run.plan : null;
  if (!plan || effort || lenses) {
    const storedRules = Array.isArray(rc.run.rules?.rules) ? rc.run.rules.rules : undefined;
    const rebuilt = await buildPlanFor(env, {
      core: rc.core,
      cwd: rc.cwd,
      config: rc.config,
      scope: rc.run.scope,
      effort: effort ?? cleanString(plan?.effort),
      lenses,
      rules: storedRules,
      runId: rc.runId,
      runDir: rc.runDir,
    });
    plan = rebuilt.plan;
  }
  const result = await performReview(env, {
    core: rc.core,
    cwd: rc.cwd,
    config: rc.config,
    scope: rc.run.scope,
    plan,
    runId: rc.runId,
    runDir: rc.runDir,
    signal: exec?.signal,
  });
  const counts = findingCounts(result.aggregate);
  const verdict = normalizeVerdict(result.aggregate.verdict);
  const exitCode = exitCodeForVerdict(verdict);
  return {
    runId: rc.runId,
    counts,
    verdict,
    exitCode,
    usage: result.usage,
    artifacts: artifactsFor(rc.cwd, rc.runDir, ['scope', 'plan', 'reviews', 'aggregate', 'findings']),
    summary: `评审完成：blocker ${counts.blocker}、major ${counts.major}、minor ${counts.minor}、needs-human ${counts.needsHuman}；结论 ${verdict}（exitCode ${exitCode}），run ${rc.runId}`,
  };
}

async function executeReviewGate(args, exec, env) {
  const rc = await resolveRunContext(env, args?.runId);
  const core = rc.core;
  let aggregate = isPlainObject(rc.run.aggregate) ? rc.run.aggregate : null;
  if (!aggregate && isPlainObject(rc.run.reviews) && Array.isArray(rc.run.reviews.anchored)) {
    try {
      aggregate = core.aggregate.aggregateFindings({
        reviews: Array.isArray(rc.run.reviews.reviews) ? rc.run.reviews.reviews : [],
        anchored: rc.run.reviews.anchored,
        config: rc.config,
      });
    } catch {
      aggregate = null;
    }
  }
  // 与 CLI 的 gate 一致：没有 LLM 评审结果时只跑确定性命令门禁（空 findings）。
  const hadReview = Boolean(aggregate);
  if (!aggregate) aggregate = emptyAggregate();
  const gate = await performGate(core, {
    cwd: rc.cwd,
    config: rc.config,
    aggregate,
    runDir: rc.runDir,
    log: env.log,
  });
  const verdict = normalizeGateVerdict(gate.verdict);
  const exitCode = exitCodeForGate(gate, aggregate);
  const blocking = compactBlocking(gate.blocking ?? aggregate.blocking);
  const checks = compactChecks(gate.checks);
  const counts = findingCounts(aggregate);
  return {
    runId: rc.runId,
    verdict,
    exitCode,
    counts,
    blocking: blocking.blocking,
    blockingTruncated: blocking.truncated,
    checks,
    artifacts: artifactsFor(rc.cwd, rc.runDir, ['gate']),
    summary: `门禁结论：${verdict}（exitCode ${exitCode}），${checks.length} 项检查，${blocking.total} 条阻断项${hadReview ? '' : '（尚无 review_run：仅确定性门禁）'}，run ${rc.runId}`,
  };
}

async function executeReviewReport(args, exec, env) {
  const format = normalizeFormat(args?.format);
  const rc = await resolveRunContext(env, args?.runId);
  const aggregate = isPlainObject(rc.run.aggregate) ? rc.run.aggregate : emptyAggregate();
  const route = resolveModelRoute(env.ctx, rc.config, env.pluginConfig);
  const meta = reportMeta({ runId: rc.runId, reviewRecord: rc.run.reviews, route, aggregate });
  const paths = await performReport(rc.core, {
    runDir: rc.runDir,
    scope: rc.run.scope ?? null,
    plan: rc.run.plan ?? null,
    aggregate,
    gate: rc.run.gate ?? null,
    meta,
    cwd: rc.cwd,
    log: env.log,
  });

  const artifacts = artifactsFor(
    rc.cwd,
    rc.runDir,
    ['scope', 'plan', 'reviews', 'aggregate', 'gate'].filter((key) => Boolean(rc.run[key])),
  );
  if (await pathExists(path.join(rc.runDir, 'findings.json'))) {
    artifacts.findings = relPathSafe(rc.cwd, path.join(rc.runDir, 'findings.json'));
  }
  const wanted = format === 'all' ? ['md', 'json', 'sarif'] : [format];
  const missing = [];
  for (const key of wanted) {
    const file = paths[key];
    if (file && (await pathExists(file))) artifacts[REPORT_KEYS[key]] = relPathSafe(rc.cwd, file);
    else missing.push(key);
  }
  const aggregateVerdict = normalizeVerdict(aggregate.verdict);
  const verdict = rc.run.gate ? normalizeGateVerdict(rc.run.gate.verdict) : aggregateVerdict;
  const exitCode = rc.run.gate ? exitCodeForGate(rc.run.gate, aggregate) : exitCodeForVerdict(aggregateVerdict);
  const produced = wanted.filter((key) => !missing.includes(key));
  return {
    runId: rc.runId,
    verdict,
    exitCode,
    missing,
    artifacts,
    summary: `报告已生成：${produced.length > 0 ? produced.join(' / ') : '无'}${missing.length > 0 ? `（缺失 ${missing.join(' / ')}）` : ''}，run ${rc.runId}`,
  };
}

async function executeReviewLedger(args, exec, env) {
  const action = normalizeLedgerAction(args?.action);
  const core = await getCore();
  const cwd = effectiveCwd(env.ctx);
  const config = await loadEffectiveConfig(core, cwd, env.pluginConfig, {});

  if (action === 'list') {
    const runs = await safeListRuns(core, cwd, config, env.log);
    const limit = 50;
    const items = [];
    for (const run of runs.slice(0, limit)) {
      const item = {
        runId: run.runId ?? (run.runDir ? path.basename(run.runDir) : ''),
        createdAt: run.createdAt ?? run.meta?.createdAt ?? null,
        mode: run.meta?.mode ?? null,
        runDir: run.runDir ? relPathSafe(cwd, run.runDir) : null,
      };
      if (run.runDir) {
        const aggregate = await readJsonFile(path.join(run.runDir, 'aggregate.json'));
        const gate = await readJsonFile(path.join(run.runDir, 'gate.json'));
        if (aggregate) {
          item.counts = findingCounts(aggregate);
          item.verdict = normalizeVerdict(aggregate.verdict);
        }
        if (gate) {
          item.gateVerdict = normalizeGateVerdict(gate.verdict);
          item.exitCode = Number.isFinite(gate.exitCode) ? gate.exitCode : null;
        }
      }
      items.push(item);
    }
    return {
      action,
      total: runs.length,
      truncated: runs.length > limit,
      runs: items,
      summary: `共 ${runs.length} 次评审运行${runs.length > limit ? `（显示前 ${limit} 次）` : ''}`,
    };
  }

  const rc = await resolveRunContext(env, args?.runId);
  const aggregate = isPlainObject(rc.run.aggregate) ? rc.run.aggregate : null;
  const gate = isPlainObject(rc.run.gate) ? rc.run.gate : null;
  const counts = aggregate ? findingCounts(aggregate) : null;
  const verdict = aggregate ? normalizeVerdict(aggregate.verdict) : null;
  const exitCode = gate ? exitCodeForGate(gate, aggregate) : verdict ? exitCodeForVerdict(verdict) : null;
  const findings = topFindings(aggregate);
  const artifacts = artifactsFor(
    rc.cwd,
    rc.runDir,
    ['scope', 'plan', 'reviews', 'aggregate', 'gate'].filter((key) => Boolean(rc.run[key])),
  );
  if (await pathExists(path.join(rc.runDir, 'findings.json'))) {
    artifacts.findings = relPathSafe(rc.cwd, path.join(rc.runDir, 'findings.json'));
  }
  for (const key of ['md', 'json', 'sarif']) {
    const file = path.join(rc.runDir, `report.${key}`);
    if (await pathExists(file)) artifacts[REPORT_KEYS[key]] = relPathSafe(rc.cwd, file);
  }
  return {
    action: action === 'latest' ? 'latest' : 'show',
    runId: rc.runId,
    createdAt: rc.run.meta?.createdAt ?? null,
    mode: rc.run.meta?.mode ?? rc.run.scope?.mode ?? null,
    scopeCounts: isPlainObject(rc.run.scope) ? scopeCounts(rc.run.scope) : null,
    counts,
    verdict,
    gateVerdict: gate ? normalizeGateVerdict(gate.verdict) : null,
    exitCode,
    usage: normalizeUsage(rc.run.reviews?.usage),
    findings: findings.findings,
    totalFindings: findings.total,
    artifacts,
    summary: counts
      ? `运行 ${rc.runId}：blocker ${counts.blocker}、major ${counts.major}、minor ${counts.minor}、needs-human ${counts.needsHuman}；结论 ${verdict}${gate ? `，门禁 ${normalizeGateVerdict(gate.verdict)}` : ''}`
      : `运行 ${rc.runId}：尚无评审结果`,
  };
}

/* -------------------------------------------------------------------------- */
/* /review command                                                            */
/* -------------------------------------------------------------------------- */

function parseCommandInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const parsed = {};
  let expectBase = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (expectBase) {
      parsed.base = token;
      expectBase = false;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const flag = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase();
      const value = eq >= 0 ? token.slice(eq + 1) : tokens[index + 1];
      if (eq < 0 && value !== undefined) index += 1;
      if (flag === 'mode' && value) {
        const mode = normalizeMode(value);
        if (mode) parsed.mode = mode;
      } else if (flag === 'effort' && value) {
        const effort = normalizeEffort(value);
        if (effort) parsed.effort = effort;
      } else if (flag === 'base' && value) {
        parsed.base = value;
      }
      continue;
    }
    if (!parsed.mode && MODES.includes(lower)) {
      parsed.mode = lower;
      if (lower === 'range') expectBase = true;
      continue;
    }
    if (!parsed.effort && EFFORTS.includes(lower)) {
      parsed.effort = lower;
      continue;
    }
    if (parsed.mode === 'range' && !parsed.base) parsed.base = token;
  }
  return parsed;
}

async function executeReviewCommand(env, invocation) {
  if (COMMAND_RUNNING) {
    return { kind: 'error', text: '已有一个 /review 正在执行；请等待它完成后再试。' };
  }
  COMMAND_RUNNING = true;
  const cwd = effectiveCwd(env.ctx);
  try {
    const core = await getCore();
    const parsed = parseCommandInput(invocation?.rawInput);
    const gitDir = await pathExists(path.join(cwd, '.git'));
    let mode = parsed.mode ?? (gitDir ? 'workspace' : 'scan');
    if (!gitDir && mode !== 'scan') mode = 'scan';
    const config = await loadEffectiveConfig(
      core,
      cwd,
      env.pluginConfig,
      parsed.effort ? { review: { effort: parsed.effort } } : {},
    );
    const { scope, runId, runDir } = await createScopeAndRun(env, {
      core,
      cwd,
      config,
      mode,
      base: parsed.base,
      scanPath: mode === 'scan' ? cwd : undefined,
    });
    const { plan } = await buildPlanFor(env, {
      core,
      cwd,
      config,
      scope,
      effort: parsed.effort ?? config.review?.effort,
      runId,
      runDir,
    });
    throwIfAborted(invocation?.signal, cwd);
    const reviewed = await performReview(env, {
      core,
      cwd,
      config,
      scope,
      plan,
      runId,
      runDir,
      signal: invocation?.signal,
    });
    throwIfAborted(invocation?.signal, cwd);
    const gate = await performGate(core, { cwd, config, aggregate: reviewed.aggregate, runDir, log: env.log });
    const route = resolveModelRoute(env.ctx, config, env.pluginConfig);
    let reportNote = '';
    try {
      await performReport(core, {
        runDir,
        scope,
        plan,
        aggregate: reviewed.aggregate,
        gate,
        meta: reportMeta({ runId, reviewRecord: reviewed.reviewRecord, route, aggregate: reviewed.aggregate }),
        cwd,
        log: env.log,
      });
      reportNote = '，报告已生成';
    } catch (err) {
      env.log('warn', `报告生成失败：${sanitizeText(err?.message, cwd)}`);
      reportNote = `，报告生成失败（${errorPayload(err, cwd).error.code}）`;
    }
    const counts = findingCounts(reviewed.aggregate);
    const verdict = normalizeVerdict(reviewed.aggregate.verdict);
    const gateVerdict = normalizeGateVerdict(gate.verdict);
    const exitCode = exitCodeForGate(gate, reviewed.aggregate);
    const scopeSummary = scopeCounts(scope);
    const text = truncateText(
      [
        `run ${runId}`,
        `${mode} 模式`,
        `${scopeSummary.reviewable} 个可评审文件`,
        `${Array.isArray(plan.units) ? plan.units.length : 0} 个评审单元`,
        `blocker ${counts.blocker} · major ${counts.major} · minor ${counts.minor} · needs-human ${counts.needsHuman}`,
        `结论 ${verdict}（聚合）· ${gateVerdict}（门禁）· exitCode ${exitCode}`,
        `产物 ${relPathSafe(cwd, runDir)}/${reportNote}`,
      ].join(' · '),
      1500,
    );
    return { kind: 'success', text };
  } catch (err) {
    const payload = errorPayload(err, cwd);
    return {
      kind: 'error',
      text: truncateText(`代码评审失败（${payload.error.code}）：${payload.error.message}`, 1500),
    };
  } finally {
    COMMAND_RUNNING = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional HTTP API                                                          */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
    }
    res.end(body);
  } catch {
    try {
      res.statusCode = 500;
      res.end('{"error":{"code":"INTERNAL","message":"响应生成失败"}}');
    } catch {
      /* the socket may already be closed */
    }
  }
}

function requestPath(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/';
  const query = raw.indexOf('?');
  return query >= 0 ? raw.slice(0, query) : raw;
}

function requestMethod(req) {
  return String(req?.method ?? 'GET').toUpperCase();
}

function buildHttpHandlers(env) {
  const listHandler = async (req, res) => {
    const method = requestMethod(req);
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' } });
      return;
    }
    try {
      const core = await getCore();
      const cwd = effectiveCwd(env.ctx);
      const config = await loadEffectiveConfig(core, cwd, env.pluginConfig, {});
      const runs = await safeListRuns(core, cwd, config, env.log);
      const limit = 100;
      const items = runs.slice(0, limit).map((run) => ({
        runId: run.runId ?? (run.runDir ? path.basename(run.runDir) : ''),
        createdAt: run.createdAt ?? run.meta?.createdAt ?? null,
        mode: run.meta?.mode ?? null,
        runDir: run.runDir ? relPathSafe(cwd, run.runDir) : null,
      }));
      sendJson(res, 200, { schemaVersion: 1, total: runs.length, truncated: runs.length > limit, runs: items });
    } catch {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: '读取运行列表失败' } });
    }
  };

  const reportHandler = async (req, res) => {
    const method = requestMethod(req);
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' } });
      return;
    }
    try {
      const match = /^\/code-review\/runs\/([^/]+)\/report\.json$/.exec(requestPath(req));
      if (!match) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '未知路径' } });
        return;
      }
      let runId;
      try {
        runId = decodeURIComponent(match[1]);
      } catch {
        sendJson(res, 400, { error: { code: 'USAGE', message: '无效的 runId' } });
        return;
      }
      if (!RUN_REF_RE.test(runId) || runId.includes('..')) {
        sendJson(res, 400, { error: { code: 'USAGE', message: '无效的 runId' } });
        return;
      }
      const core = await getCore();
      const cwd = effectiveCwd(env.ctx);
      const config = await loadEffectiveConfig(core, cwd, env.pluginConfig, {});
      const runDir = await core.store.resolveRunDir(cwd, config, runId);
      const text = await readFile(path.join(runDir, 'report.json'), 'utf8');
      JSON.parse(text);
      res.statusCode = 200;
      if (typeof res.setHeader === 'function') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
      }
      res.end(text);
    } catch {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '该运行没有 report.json，或不在当前工作目录' } });
    }
  };

  return { listHandler, reportHandler };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

function runEffect(ctx, label, setup, log, cwd) {
  const guardedSetup = () => {
    try {
      const disposer = setup();
      return typeof disposer === 'function' ? disposer : () => {};
    } catch (err) {
      log('error', `${label} 初始化失败：${sanitizeText(err?.message, cwd)}`);
      return () => {};
    }
  };
  if (ctx && typeof ctx.effect === 'function') {
    try {
      const disposer = ctx.effect(guardedSetup, label);
      if (typeof disposer === 'function') return disposer;
      return undefined;
    } catch (err) {
      log('warn', `${label} 注册失败，改为直接初始化：${sanitizeText(err?.message, cwd)}`);
      return guardedSetup();
    }
  }
  return guardedSetup();
}

function renderResult(_args, value) {
  let text;
  if (value && isPlainObject(value.error)) {
    text = `代码评审失败（${value.error.code}）：${value.error.message}`;
  } else if (value && typeof value.summary === 'string' && value.summary) {
    text = value.summary;
  } else {
    text = compactJson(value);
  }
  return [{ type: 'text', text: truncateText(String(text).replace(/\s*\n\s*/g, ' '), 4000) }];
}

function guardTool(toolName, env, fn) {
  return async (args, exec) => {
    try {
      return await fn(args, exec, env);
    } catch (err) {
      const payload = errorPayload(err, effectiveCwd(env.ctx));
      env.log('warn', `${toolName} 失败（${payload.error.code}）：${payload.error.message}`);
      return payload;
    }
  };
}

function jsonString(description) {
  return description ? { type: 'string', description } : { type: 'string' };
}

/**
 * Coerce a tool result to its declared output schema.
 *
 * The core engine uses `null` for absent optional values (e.g. `excludeReason`,
 * `gateVerdict`, usage before an LLM run). The harness validates every tool result
 * against the declared schema, so optional nulls must be dropped and required ones
 * replaced by the type's zero value. This keeps the schemas honest without making
 * every field nullable.
 */
function sanitizeOutput(value, schema) {
  if (!schema) return value;
  if (value === null || value === undefined) {
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === 'string') return '';
    if (type === 'number' || type === 'integer') return 0;
    if (type === 'boolean') return false;
    if (type === 'array') return [];
    if (type === 'object') return {};
    return value;
  }
  if (Array.isArray(value)) {
    if (schema.type === 'array' && schema.items) return value.map((item) => sanitizeOutput(item, schema.items));
    return value;
  }
  if (typeof value === 'object' && schema.type === 'object' && schema.properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) {
        if (required.has(key)) out[key] = sanitizeOutput(item, schema.properties[key] ?? {});
        continue;
      }
      out[key] = Object.prototype.hasOwnProperty.call(schema.properties, key)
        ? sanitizeOutput(item, schema.properties[key])
        : item;
    }
    return out;
  }
  return value;
}

function jsonNumber(description) {
  return description ? { type: 'number', description } : { type: 'number' };
}

function jsonBoolean(description) {
  return description ? { type: 'boolean', description } : { type: 'boolean' };
}

function jsonObjectSchema(properties, description) {
  const schema = { type: 'object', properties, additionalProperties: true };
  if (description) schema.description = description;
  return schema;
}

function jsonArraySchema(items, description) {
  const schema = { type: 'array', items };
  if (description) schema.description = description;
  return schema;
}

function errorSchema() {
  return jsonObjectSchema(
    {
      code: jsonString('稳定的错误码，如 USAGE / GIT / LLM / GATE / ENGINE_UNAVAILABLE'),
      message: jsonString('可读的中文错误信息'),
    },
    '失败信息；成功时不出现',
  );
}

function resultSchema(properties, description) {
  return {
    type: 'object',
    description,
    properties: { ...properties, error: errorSchema() },
    additionalProperties: true,
  };
}

const COUNT_SCHEMA = jsonObjectSchema(
  {
    blocker: jsonNumber(),
    major: jsonNumber(),
    minor: jsonNumber(),
    needsHuman: jsonNumber(),
    dropped: jsonNumber(),
  },
  '按严重级别的 findings 计数',
);

const USAGE_SCHEMA = jsonObjectSchema(
  {
    inputTokens: jsonNumber(),
    outputTokens: jsonNumber(),
    cacheReadTokens: jsonNumber(),
    cacheWriteTokens: jsonNumber(),
    calls: jsonNumber(),
    durationMs: jsonNumber(),
  },
  '累计模型用量（不含 API key）',
);

const ARTIFACTS_SCHEMA = jsonObjectSchema(
  { runDir: jsonString('运行目录（仓库相对 POSIX 路径）') },
  '产物路径（仓库相对 POSIX 路径）',
);

function buildToolDefinitions(env) {
  return [
    {
      name: 'review_scope',
      description:
        '确定本次代码评审的范围并创建 run。Git 仓库可用 workspace（工作区）、staged（暂存区）、range（base..head）、commit（head 指定的提交）；普通目录用 scan 全量扫描。返回 runId、文件计数与产物目录，后续 review_plan/review_run/review_gate/review_report 都用这个 runId。写代码后、开始评审前先调用。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: MODES, description: '评审模式；省略时 Git 仓库用 workspace、普通目录用 scan。' },
          base: jsonString('range 模式的基线引用，如 main 或 origin/main。'),
          head: jsonString('range 模式的终点引用（默认 HEAD）；commit 模式用它指定提交引用（如 HEAD~1 或 SHA）。'),
          path: jsonString('scan 模式要扫描的目录（相对当前工作目录或 repo），默认 scan 时即仓库根。'),
          repo: jsonString('目标仓库根目录（相对当前工作目录；默认当前工作目录）。'),
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            runId: jsonString('运行 id，形如 run-YYYYMMDD-HHmmss-ab12'),
            mode: jsonString('实际使用的模式'),
            counts: COUNT_SCHEMA,
            files: jsonArraySchema(
              jsonObjectSchema({
                path: jsonString(),
                status: jsonString(),
                reviewable: jsonBoolean(),
                excludeReason: jsonString(),
                insertions: jsonNumber(),
                deletions: jsonNumber(),
              }),
              '纳入评审的文件（最多 40 条）',
            ),
            fileCount: jsonNumber(),
            truncated: jsonBoolean(),
            coverage: jsonObjectSchema({
              complete: jsonBoolean(),
              unreviewed: jsonArraySchema(jsonString('未评审文件路径'), '最多 40 条'),
              unreviewedTotal: jsonNumber(),
              truncated: jsonBoolean(),
            }),
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_scope 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.scope,
      isConcurrencySafe: () => false,
      execute: guardTool('review_scope', env, executeReviewScope),
    },
    {
      name: 'review_plan',
      description:
        '为已创建的 run 生成评审计划：按目录/行数把文件打包成评审单元，绑定内置与项目规则、并为每个单元分配视角。在 review_scope 之后、review_run 之前调用；可覆盖 effort（quick/standard/deep）。',
      parameters: {
        type: 'object',
        properties: {
          runId: jsonString('运行 id；省略时使用最近一次运行。'),
          effort: { type: 'string', enum: EFFORTS, description: '评审力度；省略时用配置 review.effort。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            runId: jsonString(),
            effort: jsonString(),
            lenses: jsonArraySchema(jsonString('视角 id')),
            units: jsonArraySchema(
              jsonObjectSchema({
                unitId: jsonString(),
                files: jsonArraySchema(jsonString('文件路径')),
                lenses: jsonArraySchema(jsonString('视角 id')),
                ruleCount: jsonNumber(),
                changedLines: jsonNumber(),
              }),
              '评审单元（最多 30 条）',
            ),
            unitCount: jsonNumber(),
            fileCount: jsonNumber(),
            skippedFileCount: jsonNumber(),
            truncated: jsonBoolean(),
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_plan 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.plan,
      isConcurrencySafe: () => false,
      execute: guardTool('review_plan', env, executeReviewPlan),
    },
    {
      name: 'review_run',
      description:
        '对 run 的评审单元并发调用当前会话模型评审，随后定位行号、过滤明显假阳性并聚合去重/跨视角投票/分级。耗时最长，建议先 review_plan（缺少计划时会自动生成）；返回 counts、verdict、exitCode、usage 与产物。',
      parameters: {
        type: 'object',
        properties: {
          runId: jsonString('运行 id；省略时使用最近一次运行。'),
          effort: { type: 'string', enum: EFFORTS, description: '覆盖评审力度（影响视角数量）。' },
          lenses: jsonArraySchema({ type: 'string', enum: LENS_IDS }, '覆盖视角集合；省略时按 effort 自动选择。'),
          rounds: { type: 'integer', minimum: 1, maximum: 3, description: '评审轮数（deep 模式常用 2）。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            runId: jsonString(),
            counts: COUNT_SCHEMA,
            verdict: jsonString('pass / block / needs-human'),
            exitCode: jsonNumber('0 通过；2 阻断；3 需要人工'),
            usage: USAGE_SCHEMA,
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_run 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.run,
      isConcurrencySafe: () => false,
      execute: guardTool('review_run', env, executeReviewRun),
    },
    {
      name: 'review_gate',
      description:
        '执行门禁：按配置运行确定性命令（测试/lint/typecheck，可自动探测），结合阻断级 findings 计算 verdict 与退出码。通常在 review_run 之后调用；也可只跑确定性门禁（此时按空 findings 处理）。软门禁，只返回结论、不拦截其他工具；写回 gate.json。',
      parameters: {
        type: 'object',
        properties: {
          runId: jsonString('运行 id；省略时使用最近一次运行。'),
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            runId: jsonString(),
            verdict: jsonString('pass / fail / needs-human / error'),
            exitCode: jsonNumber('0/2/3/4/5'),
            counts: COUNT_SCHEMA,
            blocking: jsonArraySchema(
              jsonObjectSchema({
                fingerprint: jsonString(),
                file: jsonString(),
                startLine: jsonNumber(),
                severity: jsonString(),
                title: jsonString(),
              }),
              '阻断项（最多 20 条）',
            ),
            blockingTruncated: jsonBoolean(),
            checks: jsonArraySchema(
              jsonObjectSchema({
                id: jsonString(),
                cmd: jsonString(),
                exit: jsonNumber(),
                durationMs: jsonNumber(),
                required: jsonBoolean(),
                skipped: jsonBoolean(),
                timedOut: jsonBoolean(),
                stdoutTail: jsonString(),
              }),
              '门禁检查（最多 20 条）',
            ),
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_gate 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.gate,
      isConcurrencySafe: () => false,
      execute: guardTool('review_gate', env, executeReviewGate),
    },
    {
      name: 'review_report',
      description:
        '把 run 的范围、计划、findings 与门禁结果写成 report.md / report.json / report.sarif，返回产物路径与结论。在 review_gate 之后调用；报告面向人类与 CI/SARIF 消费方。',
      parameters: {
        type: 'object',
        properties: {
          runId: jsonString('运行 id；省略时使用最近一次运行。'),
          format: { type: 'string', enum: FORMATS, description: '输出格式；默认 all（三种都写）。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            runId: jsonString(),
            verdict: jsonString(),
            exitCode: jsonNumber(),
            missing: jsonArraySchema(jsonString('格式名')),
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_report 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.report,
      isConcurrencySafe: () => false,
      execute: guardTool('review_report', env, executeReviewReport),
    },
    {
      name: 'review_ledger',
      description:
        '查看历史评审运行：action=list 列出当前工作目录下的 run，show 查看指定 run 的计数/结论/产物/前 10 条 findings，latest 查看最近一次。用于回溯旧 run 或确认上一次评审证据。只读，不调用模型。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: LEDGER_ACTIONS, description: 'list（默认）/ show / latest。' },
          runId: jsonString('show 时指定运行 id；省略时使用最近一次运行。'),
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: resultSchema(
          {
            action: jsonString(),
            total: jsonNumber(),
            truncated: jsonBoolean(),
            runs: jsonArraySchema(jsonObjectSchema({ runId: jsonString(), createdAt: jsonString(), mode: jsonString(), runDir: jsonString() })),
            runId: jsonString(),
            createdAt: jsonString(),
            mode: jsonString(),
            counts: COUNT_SCHEMA,
            verdict: jsonString(),
            gateVerdict: jsonString(),
            exitCode: jsonNumber(),
            usage: USAGE_SCHEMA,
            findings: jsonArraySchema(
              jsonObjectSchema({
                file: jsonString(),
                startLine: jsonNumber(),
                severity: jsonString(),
                status: jsonString(),
                votes: jsonNumber(),
                problem: jsonString(),
              }),
              '前 10 条 findings',
            ),
            totalFindings: jsonNumber(),
            artifacts: ARTIFACTS_SCHEMA,
            summary: jsonString('一行摘要'),
          },
          'review_ledger 成功结果',
        ),
        render: renderResult,
      },
      timeoutMs: TOOL_TIMEOUTS.ledger,
      isConcurrencySafe: () => false,
      execute: guardTool('review_ledger', env, executeReviewLedger),
    },
  ];
}

function registerTools(env) {
  runEffect(
    env.ctx,
    'code-review/tools',
    () => {
      const registry = env.ctx?.tools;
      if (!registry || typeof registry.register !== 'function') {
        env.log('warn', 'tools 服务不可用，跳过代码评审工具注册');
        return () => {};
      }
      const disposers = [];
      for (const definition of buildToolDefinitions(env)) {
        try {
          const originalExecute = definition.execute;
          if (typeof originalExecute === 'function') {
            definition.execute = async (args, exec) =>
              sanitizeOutput(await originalExecute(args, exec), definition.output?.schema);
          }
          const disposer = registry.register(definition);
          if (typeof disposer === 'function') disposers.push(disposer);
          env.log('debug', `已注册工具 ${definition.name}`);
        } catch (err) {
          env.log('warn', `注册工具 ${definition.name} 失败：${sanitizeText(err?.message)}`);
        }
      }
      return () => {
        while (disposers.length > 0) {
          const disposer = disposers.pop();
          try {
            disposer();
          } catch {
            /* ignore disposal failures */
          }
        }
      };
    },
    env.log,
    effectiveCwd(env.ctx),
  );
}

function registerCommand(env) {
  runEffect(
    env.ctx,
    'code-review/command',
    () => {
      const registry = env.ctx?.commands;
      if (!registry || typeof registry.register !== 'function') {
        env.log('warn', 'commands 服务不可用，跳过 /review 注册');
        return () => {};
      }
      const definition = {
        name: 'review',
        description:
          '对当前工作区运行完整代码评审：scope → plan → 模型评审 → 门禁 → 报告。用法 /review [workspace|staged|range|scan] [quick|standard|deep] [base]。',
        input: { hint: '[workspace|staged|range|scan] [quick|standard|deep] [base]' },
        handler: (invocation) => executeReviewCommand(env, invocation),
      };
      try {
        const disposer = registry.register(definition);
        env.log('debug', '已注册 /review 命令');
        return typeof disposer === 'function' ? disposer : () => {};
      } catch (err) {
        env.log('warn', `注册 /review 命令失败：${sanitizeText(err?.message)}`);
        return () => {};
      }
    },
    env.log,
    effectiveCwd(env.ctx),
  );
}

function registerHttp(env) {
  runEffect(
    env.ctx,
    'code-review/http',
    () => {
      let server = null;
      try {
        server = env.ctx?.get?.('webServer');
      } catch {
        server = null;
      }
      if (!server || typeof server.register !== 'function') {
        env.log('debug', 'webServer 不可用，跳过代码评审 HTTP 路由');
        return () => {};
      }
      const { listHandler, reportHandler } = buildHttpHandlers(env);
      const disposers = [];
      try {
        const disposer = server.register({ kind: 'exact', path: '/code-review/runs', handler: listHandler });
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (err) {
        env.log('warn', `注册 /code-review/runs 路由失败：${sanitizeText(err?.message)}`);
      }
      try {
        const disposer = server.register({ kind: 'prefix', path: '/code-review/runs/', handler: reportHandler });
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (err) {
        env.log('warn', `注册 /code-review/runs/<id>/report.json 路由失败：${sanitizeText(err?.message)}`);
      }
      return () => {
        while (disposers.length > 0) {
          const disposer = disposers.pop();
          try {
            disposer();
          } catch {
            /* ignore disposal failures */
          }
        }
      };
    },
    env.log,
    effectiveCwd(env.ctx),
  );
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

export function apply(ctx, config) {
  if (!ctx || typeof ctx !== 'object') return;
  const env = {
    ctx,
    pluginConfig: isPlainObject(config) ? config : {},
    log: createLog(ctx),
  };
  registerTools(env);
  registerCommand(env);
  registerHttp(env);
}
