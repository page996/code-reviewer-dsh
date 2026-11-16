/**
 * lib/review.mjs — CONTRACT §6: concurrent review orchestration (unit × lens).
 *
 * `runReview({ scope, plan, config, llm, cwd, log, signal })`
 *   -> { rounds, reviews, usage, calls, durationMs, startedAt, finishedAt }
 *
 * Behaviour:
 *   - one `llm.complete` per (unit, lens), bounded by `config.review.concurrency`;
 *   - schema failure -> retry the same (unit, lens) ONCE, then emit a synthetic
 *     `needs-human` finding carrying the schema error (never silently swallowed);
 *   - transport failure -> review entry gets `{ error: {code, message} }` and the
 *     run continues (runReview never throws for a single reviewer failure);
 *   - `config.review.rounds > 1` -> a verification round 2 over previously
 *     confirmed findings + the affected files' diffs only;
 *   - aggregates token usage + number of LLM calls + duration.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { buildReviewerPrompt, parseReviewerOutput } from './prompts.mjs';
import { normalizeTitle } from './aggregate.mjs';

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_COMMENTS = 30;
const DEFAULT_LENSES = ['intent', 'correctness'];
const DEFAULT_VOTES_FOR_MAJOR = 2;
const DEFAULT_ROUNDS = 1;
const OUTPUT_PREVIEW_CHARS = 500;

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function makeLogger(log) {
  return (level, message, extra) => {
    if (typeof log !== 'function') return;
    try {
      log(level, message, extra);
    } catch {
      /* logging must never break the review */
    }
  };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  const numberOr0 = (value) => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    inputTokens: numberOr0(usage.inputTokens ?? usage.input_tokens),
    outputTokens: numberOr0(usage.outputTokens ?? usage.output_tokens),
    cacheReadTokens: numberOr0(usage.cacheReadTokens ?? usage.cache_read_input_tokens),
    cacheWriteTokens: numberOr0(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens),
  };
}

function addUsage(total, usage) {
  const normalized = normalizeUsage(usage);
  for (const key of Object.keys(total)) total[key] += normalized[key];
  return total;
}

function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function resolveLenses(plan, config) {
  const fromPlan = Array.isArray(plan?.lenses) ? plan.lenses : null;
  if (fromPlan && fromPlan.length > 0) {
    return fromPlan.filter((lens) => typeof lens === 'string' && lens.trim() !== '');
  }
  const configured = Array.isArray(config?.review?.lenses) ? config.review.lenses : null;
  if (configured && configured.length > 0) {
    return configured.filter((lens) => typeof lens === 'string' && lens.trim() !== '');
  }
  return [...DEFAULT_LENSES];
}

function resolveConcurrency(config) {
  const raw = Number(config?.review?.concurrency);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.floor(raw));
}

function resolveMaxComments(config) {
  const raw = Number(config?.review?.maxComments);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_COMMENTS;
  return Math.floor(raw);
}

/**
 * Reviewer sampling temperature. Defaults to 0 so repeated runs over the same unit are
 * reproducible (case `review eval` compares runs across time); a deployment may opt into
 * sampling with `review.temperature`.
 */
function resolveTemperature(config) {
  const raw = Number(config?.review?.temperature);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_TEMPERATURE;
  return raw;
}

/** Provider/transport error codes worth retrying inside one reviewer call. */
const TRANSIENT_REVIEWER_CODES = new Set([
  'LLM',
  'TRANSPORT',
  'LLM_SERVER',
  'LLM_RATE_LIMIT',
  'LLM_TIMEOUT',
  'LLM_STREAM_CLOSED',
  'LLM_EMPTY_RESPONSE',
]);

function isTransientReviewerError(code) {
  return TRANSIENT_REVIEWER_CODES.has(String(code ?? ''));
}

/** Abort-aware delay used between reviewer retries. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function resolveRounds(config, plan) {
  const fromConfig = Number(config?.review?.rounds);
  const fromPlan = Number(plan?.rounds);
  const configured = Number.isFinite(fromConfig) && fromConfig >= 1 ? Math.floor(fromConfig) : 1;
  const planned = Number.isFinite(fromPlan) && fromPlan >= 1 ? Math.floor(fromPlan) : 1;
  // CONTRACT §4: effort=deep implies rounds >= 2. plan.mjs encodes that in
  // `plan.rounds`; honour it even when the config still says rounds=1.
  return Math.max(configured, planned, DEFAULT_ROUNDS);
}

function resolveVotesForMajor(config) {
  const raw = Number(config?.review?.votesForMajor);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_VOTES_FOR_MAJOR;
  return Math.floor(raw);
}

/** Optional task contract: inline `review.contractText` or `review.contractFile`. */
export function loadContractText({ config, cwd } = {}) {
  const inline = config?.review?.contractText;
  if (typeof inline === 'string' && inline.trim() !== '') return inline;
  const file = config?.review?.contractFile;
  if (typeof file !== 'string' || file.trim() === '') return null;
  const resolved = isAbsolute(file) ? file : join(cwd ?? process.cwd(), file);
  try {
    const text = readFileSync(resolved, 'utf8');
    return text.trim() !== '' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Run `worker` over `items` with bounded concurrency. Workers never throw here:
 * each worker is responsible for returning an entry for its own failure.
 */
async function mapWithConcurrency(items, limit, worker, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function makeSyntheticSchemaFinding({ lens, unit, schemaError, outputPreview }) {
  const firstFile = Array.isArray(unit?.files) ? unit.files.find((file) => file?.path) : null;
  return {
    file: typeof firstFile?.path === 'string' ? firstFile.path : '',
    existing_code: '',
    line: null,
    category: 'other',
    severity: 'minor',
    problem: `评审输出无法解析（lens=${lens}）：${toText(schemaError).slice(0, 200)}`,
    evidence: '',
    impact: '该视角的本次评审结果不可用，可能漏报该视角下的真实问题。',
    suggestion: '人工复核该变更单元，或重跑该视角的评审。',
    preexisting: false,
    needsHuman: true,
    lens,
    llmOutputPreview: toText(outputPreview).slice(0, OUTPUT_PREVIEW_CHARS),
  };
}

/**
 * One reviewer call with one schema retry.
 * Never throws; returns a review entry.
 */
async function runOneReviewer({
  llm,
  unit,
  lens,
  round,
  contract,
  maxComments,
  temperature,
  scanMode,
  signal,
  log,
}) {
  const unitId = typeof unit?.unitId === 'string' ? unit.unitId : '';
  const entry = {
    unitId,
    lens,
    round,
    findings: [],
    humanAttention: [],
    verdict: null,
    usage: emptyUsage(),
    calls: 0,
  };

  let prompt;
  try {
    prompt = buildReviewerPrompt({ unit, lens, contract, maxComments });
  } catch (err) {
    entry.error = { code: 'PROMPT', message: toText(err?.message ?? err) };
    return entry;
  }

  let lastSchemaError = null;
  let lastPreview = '';
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      entry.error = { code: 'LLM_TIMEOUT', message: '评审被取消' };
      return entry;
    }
    let completion;
    try {
      completion = await llm.complete({ system: prompt.system, user: prompt.user, temperature, signal });
    } catch (err) {
      entry.calls += 1;
      addUsage(entry.usage, err?.usage);
      const code = typeof err?.code === 'string' ? err.code : 'LLM';
      // Transient transport/provider failures are retried; a hard 4xx or a schema
      // failure is not (schema gets its own single retry below).
      if (attempt < attempts && isTransientReviewerError(code)) {
        log('warn', `reviewer transport error (unit=${unitId}, lens=${lens}, attempt=${attempt}): ${code}; retrying`);
        await delay(500 * attempt, signal);
        continue;
      }
      entry.error = {
        code,
        message: toText(err?.message ?? err).slice(0, 2000),
      };
      return entry;
    }
    entry.calls += 1;
    if (completion && typeof completion === 'object') {
      addUsage(entry.usage, completion.usage);
      lastPreview = toText(completion.text);
    } else {
      lastPreview = '';
    }
    const parsed = parseReviewerOutput(completion?.text);
    if (!parsed.schemaError) {
      entry.findings = parsed.findings.map((finding) => ({
        ...finding,
        lens,
        // In scan mode every finding describes existing code, so it is pre-existing by
        // definition and must not block a change gate (CONTRACT §3/§6).
        ...(scanMode ? { preexisting: true } : {}),
      }));
      entry.humanAttention = parsed.humanAttention;
      entry.verdict = parsed.verdict;
      return entry;
    }
    lastSchemaError = parsed.schemaError;
    log('debug', `reviewer schema error (unit=${unitId}, lens=${lens}, attempt=${attempt}): ${lastSchemaError}`);
    if (attempt >= 2) break;
    await delay(250 * attempt, signal);
  }

  entry.schemaError = lastSchemaError;
  entry.findings = [
    makeSyntheticSchemaFinding({
      lens,
      unit,
      schemaError: lastSchemaError,
      outputPreview: lastPreview,
    }),
  ];
  entry.verdict = 'needs-human';
  return entry;
}

/* ------------------------------------------------------------------------- */
/* round 2: previously-confirmed findings                                    */
/* ------------------------------------------------------------------------- */

function confirmedFromReviews(reviews, votesForMajor) {
  const groups = new Map();
  for (const review of reviews) {
    if (!review || review.error || !Array.isArray(review.findings)) continue;
    const lens = typeof review.lens === 'string' ? review.lens : 'unknown';
    for (const finding of review.findings) {
      if (!finding || typeof finding !== 'object') continue;
      const file = toText(finding.file).replace(/\\/g, '/');
      if (!file) continue;
      const category = toText(finding.category).toLowerCase() || 'other';
      const title = normalizeTitle(finding);
      const key = `${file}|${category}|${title}`;
      if (!groups.has(key)) {
        groups.set(key, { finding: { ...finding, file, category }, lenses: new Set(), unitIds: new Set() });
      }
      const group = groups.get(key);
      group.lenses.add(lens);
      if (typeof review.unitId === 'string') group.unitIds.add(review.unitId);
      if (toText(finding.evidence) !== '') group.finding.evidence = finding.evidence;
    }
  }
  const confirmed = [];
  for (const group of groups.values()) {
    const votes = group.lenses.size;
    const severity = toText(group.finding.severity).toLowerCase();
    const hasEvidence = toText(group.finding.evidence) !== '';
    const isBlockingSeverity = severity === 'blocker' || severity === 'major';
    if (!hasEvidence) continue;
    if (votes < votesForMajor && !(severity === 'blocker' && votes >= 1)) continue;
    void isBlockingSeverity;
    confirmed.push({
      ...group.finding,
      votes,
      lenses: [...group.lenses],
      unitIds: [...group.unitIds],
    });
  }
  return confirmed;
}

function buildRound2Units(plan, confirmed) {
  const byFile = new Map();
  for (const finding of confirmed) {
    const file = toText(finding.file).replace(/\\/g, '/');
    if (!file) continue;
    byFile.set(file, true);
  }
  if (byFile.size === 0) return [];
  const units = [];
  for (const unit of Array.isArray(plan?.units) ? plan.units : []) {
    const affected = (Array.isArray(unit?.files) ? unit.files : []).filter((file) =>
      byFile.has(toText(file?.path).replace(/\\/g, '/')),
    );
    if (affected.length === 0) continue;
    const prior = confirmed.filter((finding) =>
      affected.some((file) => toText(file?.path).replace(/\\/g, '/') === toText(finding.file).replace(/\\/g, '/')),
    );
    units.push({
      ...unit,
      unitId: `${typeof unit?.unitId === 'string' ? unit.unitId : 'u'}-r2`,
      round: 2,
      files: affected,
      priorFindings: prior,
    });
  }
  return units;
}

/* ------------------------------------------------------------------------- */
/* public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {{scope?: object, plan?: object, config?: object, llm?: object,
 *          cwd?: string, log?: Function, signal?: AbortSignal}} args
 */
export async function runReview({ scope, plan, config, llm, cwd, log, signal } = {}) {
  void scope;
  const logger = makeLogger(log);
  const workDir = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const units = Array.isArray(plan?.units) ? plan.units : [];
  const lenses = resolveLenses(plan, config);
  const concurrency = resolveConcurrency(config);
  const maxComments = resolveMaxComments(config);
  const temperature = resolveTemperature(config);
  const scanMode = plan?.mode === 'scan';
  const configuredRounds = resolveRounds(config, plan);
  const votesForMajor = resolveVotesForMajor(config);
  const contract = loadContractText({ config, cwd: workDir });

  const totalUsage = emptyUsage();
  const reviews = [];
  let calls = 0;

  const finish = (rounds) => {
    const finishedAt = new Date().toISOString();
    return {
      rounds,
      reviews,
      usage: totalUsage,
      calls,
      durationMs: Date.now() - startedMs,
      startedAt,
      finishedAt,
    };
  };

  if (units.length === 0 || lenses.length === 0) {
    logger('info', 'runReview: 没有可评审的 unit/lens，跳过');
    return finish(0);
  }
  if (typeof llm?.complete !== 'function') {
    throw makeError('CONFIG', 'runReview 需要注入 llm.complete(req)');
  }
  if (signal?.aborted) {
    logger('warn', 'runReview: 收到取消信号，未开始评审');
    return finish(0);
  }

  const tasks = [];
  for (const unit of units) {
    for (const lens of lenses) tasks.push({ unit, lens, round: 1 });
  }
  logger('info', `runReview: round1 ${tasks.length} 次评审（concurrency=${concurrency}）`);

  const round1Entries = await mapWithConcurrency(
    tasks,
    concurrency,
    async ({ unit, lens, round }) => {
      const entry = await runOneReviewer({
        llm,
        unit,
        lens,
        round,
        contract,
        maxComments,
        temperature,
        scanMode,
        signal,
        log: logger,
      });
      calls += entry.calls;
      addUsage(totalUsage, entry.usage);
      if (entry.error) {
        logger('warn', `reviewer 失败 unit=${entry.unitId} lens=${lens}: ${entry.error.code} ${entry.error.message}`);
      } else if (entry.schemaError) {
        logger('warn', `reviewer 输出不可解析 unit=${entry.unitId} lens=${lens}: ${entry.schemaError}`);
      }
      return entry;
    },
    signal,
  );
  for (const entry of round1Entries) {
    if (entry) reviews.push(entry);
  }

  let executedRounds = reviews.length > 0 ? 1 : 0;

  if (configuredRounds > 1 && !signal?.aborted) {
    const confirmed = confirmedFromReviews(reviews, votesForMajor);
    const round2Units = buildRound2Units(plan, confirmed);
    if (round2Units.length > 0) {
      const round2Tasks = [];
      for (const unit of round2Units) {
        for (const lens of lenses) round2Tasks.push({ unit, lens, round: 2 });
      }
      logger(
        'info',
        `runReview: round2 复核 ${confirmed.length} 条已确认问题 / ${round2Units.length} 个 unit（${round2Tasks.length} 次评审）`,
      );
      const round2Entries = await mapWithConcurrency(
        round2Tasks,
        concurrency,
        async ({ unit, lens, round }) => {
          const entry = await runOneReviewer({
            llm,
            unit,
            lens,
            round,
            contract,
            maxComments,
            temperature,
            scanMode,
            signal,
            log: logger,
          });
          calls += entry.calls;
          addUsage(totalUsage, entry.usage);
          return entry;
        },
        signal,
      );
      let added = 0;
      for (const entry of round2Entries) {
        if (entry) {
          reviews.push(entry);
          added += 1;
        }
      }
      executedRounds = added > 0 ? 2 : 1;
    } else {
      logger('debug', 'runReview: round2 没有已确认问题，跳过');
    }
  }

  logger(
    'info',
    `runReview: 完成 ${reviews.length} 个评审结果，calls=${calls}，duration=${Date.now() - startedMs}ms`,
  );
  return finish(executedRounds);
}

export default runReview;
