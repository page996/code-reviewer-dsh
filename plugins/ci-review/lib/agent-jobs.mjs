/**
 * Agent job supervision helpers for the CI review workbench.
 *
 * Why this exists: every subagent we start is an unbounded, model-driven,
 * side-effect-free but *slow* call. Without a contract a single oversized prompt
 * or a Host restart leaves a job "running" forever, and the panel then looks
 * "disconnected" while it is actually blocked on a zombie record. The rules
 * enforced here are deliberately boring and testable:
 *
 *   1. every job has a prompt budget (bytes) and a hard deadline;
 *   2. an oversized prompt is truncated with an explicit marker, never silently
 *      sent in full (a 200 KB prompt stalled grouping for ~20 minutes);
 *   3. a job never stays `running` past `deadlineAt + grace` — a watchdog marks
 *      it `failed` with `errorCode: 'timeout'`;
 *   4. after a Host restart every persisted `running` job becomes
 *      `failed/interrupted`, so the UI can offer a retry instead of waiting;
 *   5. one running job per `key` (kind + logical target) — no duplicate fan-out;
 *   6. lifecycle writes are guarded: a late result from a superseded job can
 *      never overwrite the current record.
 *
 * Pure functions only (no fs, no timers) so the rules are covered by unit tests.
 */

export const JOB_KINDS = Object.freeze([
  'group',
  'verify',
  'review',
  'audit',
  'autofix',
  'converge',
  'task',
]);

/** Hard ceiling for any supervised job (30 minutes). */
export const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** Anything larger than this is truncated before activation. */
export const HARD_PROMPT_CAP_BYTES = 400 * 1024;

const DEFAULT_TIMEOUT_MS = Object.freeze({
  group: 8 * 60 * 1000,
  verify: 6 * 60 * 1000,
  review: 10 * 60 * 1000,
  audit: 8 * 60 * 1000,
  autofix: 12 * 60 * 1000,
  converge: 10 * 60 * 1000,
  task: 30 * 60 * 1000,
});

const DEFAULT_PROMPT_BUDGET_BYTES = Object.freeze({
  group: 120 * 1024,
  verify: 40 * 1024,
  review: 64 * 1024,
  audit: 120 * 1024,
  autofix: 24 * 1024,
  converge: 64 * 1024,
  task: 32 * 1024,
});

/** Per-kind timeout from `ciReview.jobTimeoutMs.<kind>`, clamped to the hard cap. */
export function timeoutFor(kind, config = {}) {
  const override = Number(config?.ciReview?.jobTimeoutMs?.[kind]);
  const base = Number.isFinite(override) && override > 0
    ? override
    : (DEFAULT_TIMEOUT_MS[kind] ?? DEFAULT_TIMEOUT_MS.task);
  return Math.min(Math.max(15_000, Math.round(base)), MAX_JOB_TIMEOUT_MS);
}

/** Per-kind prompt budget from `ciReview.promptBudgetBytes.<kind>`. */
export function promptBudgetFor(kind, config = {}) {
  const override = Number(config?.ciReview?.promptBudgetBytes?.[kind]);
  const base = Number.isFinite(override) && override > 0
    ? override
    : (DEFAULT_PROMPT_BUDGET_BYTES[kind] ?? DEFAULT_PROMPT_BUDGET_BYTES.task);
  return Math.min(Math.max(1024, Math.round(base)), HARD_PROMPT_CAP_BYTES);
}

export function textOfPart(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string') return part.text;
  return '';
}

export function promptBytes(parts) {
  let total = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    total += Buffer.byteLength(textOfPart(part), 'utf8');
  }
  return total;
}

/**
 * Truncate the largest text part so the whole prompt fits `budget` bytes.
 * Truncation happens on a character boundary and always leaves a marker that
 * tells the model the input was clipped (so it can say "insufficient info"
 * instead of hallucinating), plus what was dropped in bytes.
 */
export function truncatePrompt(parts, budget = HARD_PROMPT_CAP_BYTES) {
  const list = Array.isArray(parts) ? parts : [];
  const originalBytes = promptBytes(list);
  if (originalBytes <= budget) {
    return { parts: list, bytes: originalBytes, originalBytes, truncated: false, droppedBytes: 0 };
  }
  const marker = (dropped) => `\n\n[ci-review] 提示词超出预算已截断：丢弃 ${dropped} bytes。请仅基于以上内容输出；信息不足时在输出中明确说明，不要臆测。`;
  // Reserve room for the marker itself so the final prompt still fits.
  const reserve = 512;
  const target = Math.max(256, budget - reserve);
  const sized = list.map((part, index) => ({ index, bytes: Buffer.byteLength(textOfPart(part), 'utf8') }));
  sized.sort((a, b) => b.bytes - a.bytes);
  const next = list.slice();
  let droppedBytes = 0;
  for (const entry of sized) {
    if (promptBytes(next) <= target) break;
    const part = next[entry.index];
    const text = textOfPart(part);
    const overflow = promptBytes(next) - target;
    if (text.length <= 1) continue;
    // Cut proportionally to the overflow, at a character boundary.
    let cutChars = Math.min(text.length - 1, Math.max(1, Math.ceil(overflow)));
    cutChars = Math.min(cutChars, text.length - 1);
    const kept = text.slice(0, text.length - cutChars);
    const removed = text.length - kept.length;
    droppedBytes += Buffer.byteLength(text.slice(kept.length), 'utf8');
    const replacement = typeof part === 'string' ? kept : { ...part, text: kept };
    next[entry.index] = replacement;
    if (removed <= 0) break;
  }
  const trimmed = next.map((part, index) => {
    const isLargest = sized[0]?.index === index;
    if (!isLargest) return part;
    const text = textOfPart(part);
    return typeof part === 'string' ? `${text}${marker(droppedBytes)}` : { ...part, text: `${text}${marker(droppedBytes)}` };
  });
  let bytes = promptBytes(trimmed);
  // Absolute guarantee: even a pathological multi-part prompt ends under budget.
  if (bytes > budget) {
    const hard = `[ci-review] 提示词超出预算（原始 ${originalBytes} bytes）已被截断。请仅基于现有信息输出。`;
    const first = trimmed[0];
    const head = textOfPart(first).slice(0, Math.max(64, budget - Buffer.byteLength(hard, 'utf8') - 8));
    const compact = typeof first === 'string' ? `${head}${hard}` : { ...first, text: `${head}${hard}` };
    return {
      parts: [compact],
      bytes: promptBytes([compact]),
      originalBytes,
      truncated: true,
      droppedBytes: Math.max(droppedBytes, originalBytes - promptBytes([compact])),
    };
  }
  return { parts: trimmed, bytes, originalBytes, truncated: true, droppedBytes };
}

export function toEpoch(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : NaN;
}

export function isRunning(job) {
  return Boolean(job) && job.status === 'running';
}

/** A running job is overdue once `deadlineAt` (or startedAt + timeoutMs) passed. */
export function isOverdue(job, now = Date.now(), graceMs = 0) {
  if (!isRunning(job)) return false;
  const deadline = Number(job.deadlineAt) || (toEpoch(job.startedAt) + (Number(job.timeoutMs) || MAX_JOB_TIMEOUT_MS));
  if (!Number.isFinite(deadline)) return false;
  return now > deadline + Math.max(0, Number(graceMs) || 0);
}

export function classifyFailure(error) {
  const text = String(error?.message ?? error ?? 'unknown error');
  const name = String(error?.name ?? '');
  const code = String(error?.code ?? '');
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timeout|timed out|AbortError|aborted/i.test(`${name} ${code} ${text}`)) {
    return { code: 'timeout', message: `超时/中断：${text.slice(0, 300)}` };
  }
  return { code: 'error', message: text.slice(0, 300) };
}

/**
 * Mark overdue running jobs as failed. Returns a NEW jobs map plus the ids that
 * were swept, so callers can persist once and log a single line.
 */
export function sweepOverdue(jobs, { now = Date.now(), graceMs = 30_000 } = {}) {
  const next = {};
  const swept = [];
  for (const [id, job] of Object.entries(jobs ?? {})) {
    if (isOverdue(job, now, graceMs)) {
      next[id] = {
        ...job,
        status: 'failed',
        errorCode: 'timeout',
        error: `任务超时（${Math.round((Number(job.timeoutMs) || 0) / 1000)}s，看门狗回收）；可重试`,
        finishedAt: new Date(now).toISOString(),
      };
      swept.push(id);
    } else {
      next[id] = job;
    }
  }
  return { jobs: next, swept };
}

/** After a Host restart no in-process result can arrive: running jobs never resume. */
export function sweepInterrupted(jobs, { now = Date.now() } = {}) {
  const next = {};
  const interrupted = [];
  for (const [id, job] of Object.entries(jobs ?? {})) {
    if (isRunning(job)) {
      next[id] = {
        ...job,
        status: 'failed',
        errorCode: 'interrupted',
        error: 'DSH 重启导致任务中断（子代理无法续跑）；可重试',
        finishedAt: new Date(now).toISOString(),
      };
      interrupted.push(id);
    } else {
      next[id] = job;
    }
  }
  return { jobs: next, interrupted };
}

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * Guarded transition. A late write from a superseded job must not resurrect or
 * overwrite a newer one; pass `expectedId`/`onlyStatuses` to enforce that.
 */
export function applyJobUpdate(jobs, id, patch, { expectedId, onlyStatuses, now = Date.now() } = {}) {
  const current = jobs?.[id];
  if (!current) return { jobs, applied: false, reason: 'missing' };
  if (expectedId && current.id !== expectedId) return { jobs, applied: false, reason: 'superseded' };
  if (Array.isArray(onlyStatuses) && !onlyStatuses.includes(current.status)) {
    return { jobs, applied: false, reason: `status:${current.status}` };
  }
  return {
    jobs: { ...jobs, [id]: { ...current, ...patch, updatedAt: new Date(now).toISOString() } },
    applied: true,
    reason: 'ok',
  };
}

/** Compact health view for the snapshot/panel. */
export function summarizeJobs(jobs, { now = Date.now(), recentLimit = 5, graceMs = 30_000 } = {}) {
  const entries = Object.entries(jobs ?? {}).map(([id, job]) => ({ id, ...job }));
  const running = entries.filter(isRunning);
  const overdue = running.filter((job) => isOverdue(job, now, graceMs));
  const byKind = {};
  for (const job of entries) {
    const kind = job.kind ?? 'unknown';
    byKind[kind] = byKind[kind] ?? { total: 0, running: 0, failed: 0, completed: 0 };
    byKind[kind].total += 1;
    if (job.status === 'running') byKind[kind].running += 1;
    else if (job.status === 'failed') byKind[kind].failed += 1;
    else if (job.status === 'completed') byKind[kind].completed += 1;
  }
  const ages = running.map((job) => now - (toEpoch(job.startedAt) || now)).filter((age) => age >= 0);
  const failures = entries
    .filter((job) => job.status === 'failed')
    .sort((a, b) => (toEpoch(b.finishedAt) || 0) - (toEpoch(a.finishedAt) || 0));
  return {
    total: entries.length,
    running: running.length,
    overdue: overdue.length,
    failed: failures.length,
    completed: entries.filter((job) => job.status === 'completed').length,
    oldestRunningSeconds: ages.length ? Math.round(Math.max(...ages) / 1000) : 0,
    byKind,
    recentFailures: failures.slice(0, recentLimit).map((job) => ({
      id: job.id,
      kind: job.kind ?? 'unknown',
      label: job.label ?? '',
      errorCode: job.errorCode ?? null,
      error: String(job.error ?? '').slice(0, 240),
      finishedAt: job.finishedAt ?? null,
    })),
  };
}
