/**
 * lib/filter.mjs — CONTRACT §6: conservative false-positive filter pass.
 *
 * `filterFindings({ unit, findings, llm, config })`
 *   -> { findings, dropped, usage, filterUsed, decisions?, error? }
 *
 * Rules:
 *   - conservative by construction: only `drop` decisions whose `reason` is
 *     non-empty are honoured; every finding the filter does not mention is kept;
 *   - any LLM / parse failure keeps ALL findings (`filterUsed:false`);
 *   - `config.review.filter === false` or a missing `llm` disables the pass.
 *
 * Findings must carry `fingerprint` (aggregate.computeFingerprint); it is
 * back-filled here when missing so the pass can run before aggregation.
 */

import { buildFilterPrompt, parseFilterOutput } from './prompts.mjs';
import { computeFingerprint } from './aggregate.mjs';

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

function keepAll(list, extra = {}) {
  return {
    findings: list,
    dropped: [],
    usage: emptyUsage(),
    filterUsed: false,
    ...extra,
  };
}

/**
 * @param {{unit?: object, findings?: Array, llm?: object, config?: object}} args
 */
export async function filterFindings({ unit, findings, llm, config } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) {
    return { findings: [], dropped: [], usage: emptyUsage(), filterUsed: false };
  }
  const withFingerprints = list.map((finding) =>
    finding && typeof finding === 'object'
      ? finding.fingerprint
        ? finding
        : { ...finding, fingerprint: computeFingerprint(finding) }
      : finding,
  );

  const enabled = config?.review?.filter !== false;
  if (!enabled) return keepAll(withFingerprints, { filterDisabled: true });
  if (typeof llm?.complete !== 'function') return keepAll(withFingerprints, { filterDisabled: true });

  const validFindings = withFingerprints.filter(
    (finding) => finding && typeof finding === 'object' && typeof finding.fingerprint === 'string',
  );
  if (validFindings.length === 0) return keepAll(withFingerprints);

  let completion;
  try {
    const prompt = buildFilterPrompt({ unit, findings: validFindings });
    completion = await llm.complete({ system: prompt.system, user: prompt.user });
  } catch (err) {
    return keepAll(withFingerprints, {
      error: {
        code: typeof err?.code === 'string' ? err.code : 'LLM',
        message: String(err?.message ?? err).slice(0, 1000),
      },
    });
  }

  const usage = normalizeUsage(completion?.usage);
  const parsed = parseFilterOutput(completion?.text);
  if (parsed.schemaError) {
    return keepAll(withFingerprints, { usage, schemaError: parsed.schemaError });
  }

  const decisions = new Map();
  for (const decision of parsed.decisions) {
    if (!decisions.has(decision.fingerprint)) decisions.set(decision.fingerprint, decision);
  }

  const kept = [];
  const dropped = [];
  for (const finding of withFingerprints) {
    if (!finding || typeof finding !== 'object') continue;
    const decision = decisions.get(finding.fingerprint);
    // Conservative: drop only on an explicit, reasoned drop decision.
    if (decision && decision.decision === 'drop' && decision.reason.trim() !== '') {
      dropped.push({ ...finding, filterReason: decision.reason });
    } else {
      kept.push(finding);
    }
  }

  return {
    findings: kept,
    dropped,
    usage,
    filterUsed: true,
    decisions: parsed.decisions,
  };
}

export default filterFindings;
