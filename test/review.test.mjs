/**
 * test/review.test.mjs — LLM review pipeline tests.
 *
 * Covers: prompt assembly/parsing (fenced / trailing prose / invalid),
 * positioning (hit / whitespace hit / miss / out-of-scope / hunk fallback),
 * aggregation (votes / needs-human / pre-existing / style-drop / maxComments /
 * dedupe / fingerprint), filter conservatism (failure keeps findings), report
 * (md/json/SARIF validity), runReview (continues after a reviewer error, schema
 * retry, round 2) and the LLM transport (stubbed fetch; no network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLlm } from '../lib/llm.mjs';
import {
  LENSES,
  buildReviewerPrompt,
  parseReviewerOutput,
  buildFilterPrompt,
  parseFilterOutput,
} from '../lib/prompts.mjs';
import { anchorFindings } from '../lib/position.mjs';
import {
  aggregateFindings,
  blockingFindings,
  computeFingerprint,
} from '../lib/aggregate.mjs';
import { filterFindings } from '../lib/filter.mjs';
import { writeReports } from '../lib/report.mjs';
import { runReview } from '../lib/review.mjs';

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dcr-review-test-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  });
  return dir;
}

function usage(input = 10, output = 5, cacheRead = 1, cacheWrite = 2) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function completion(text, { tokens } = {}) {
  return {
    text,
    usage: tokens ?? usage(),
    stopReason: 'end_turn',
    model: 'fake-model',
    effort: 'max',
  };
}

function reviewerJson({ findings = [], verdict = 'pass', humanAttention = [] } = {}) {
  return JSON.stringify({ findings, verdict, human_attention: humanAttention });
}

const FINDING_A = {
  file: 'src/a.js',
  existing_code: 'const b = 2;',
  line: 2,
  category: 'correctness',
  severity: 'major',
  problem: 'Null deref on b',
  evidence: 'b is used before assignment in the new code path',
  impact: 'runtime crash',
  suggestion: 'guard b before use',
  preexisting: false,
};

const PATCH_A = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

function anchorOne(finding, unit) {
  return anchorFindings([finding], unit)[0];
}

/* ------------------------------------------------------------------------- */
/* prompts                                                                   */
/* ------------------------------------------------------------------------- */

test('prompts: LENSES has the 10 CONTRACT lenses with Chinese instructions', () => {
  assert.equal(LENSES.length, 10);
  assert.deepEqual(
    LENSES.map((lens) => lens.id),
    ['intent', 'correctness', 'errors', 'concurrency', 'data', 'security', 'contract', 'tests', 'scope', 'history'],
  );
  for (const lens of LENSES) {
    assert.equal(typeof lens.instruction, 'string');
    assert.ok(/[\u4e00-\u9fa5]/.test(lens.instruction), `${lens.id} instruction must be Chinese`);
  }
});

test('prompts: buildReviewerPrompt embeds unit/rules/schema/hard rules', () => {
  const prompt = buildReviewerPrompt({
    unit: {
      unitId: 'u01',
      files: [{ path: 'src/a.js', patch: PATCH_A, newLineCount: 3 }],
      rules: [{ id: 'core-correctness', source: 'builtin', title: '正确性规则', body: '检查空指针。' }],
      lenses: ['correctness'],
      stats: { changedLines: 3, files: 1 },
    },
    lens: 'correctness',
    contract: '实现用户登录。',
    maxComments: 7,
  });
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
  assert.ok(prompt.user.includes('src/a.js'));
  assert.ok(prompt.user.includes('const b = 2;'));
  assert.ok(prompt.user.includes('core-correctness'));
  assert.ok(prompt.user.includes('实现用户登录。'));
  assert.ok(prompt.user.includes('existing_code'));
  assert.ok(prompt.user.includes('human_attention'));
  assert.ok(prompt.user.includes('最多输出 7 条'));
  assert.ok(prompt.user.includes('"id": "correctness"'));
});

test('prompts: parseReviewerOutput accepts fenced JSON and trailing prose', () => {
  const text = [
    '评审结果如下：',
    '```json',
    JSON.stringify({ findings: [FINDING_A], verdict: 'needs-fix', human_attention: ['确认默认值'] }),
    '```',
    '以上是本次评审的结论。',
  ].join('\n');
  const parsed = parseReviewerOutput(text);
  assert.equal(parsed.schemaError, undefined);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'src/a.js');
  assert.equal(parsed.findings[0].severity, 'major');
  assert.equal(parsed.verdict, 'needs-fix');
  assert.deepEqual(parsed.humanAttention, ['确认默认值']);
});

test('prompts: parseReviewerOutput normalizes invalid enums and missing arrays', () => {
  const parsed = parseReviewerOutput(
    '```\n{"findings":[{"file":"x.js","category":"weird","severity":"critical","problem":"p"}],"verdict":"wat"}\n```',
  );
  assert.equal(parsed.schemaError, undefined);
  assert.equal(parsed.findings[0].category, 'other');
  assert.equal(parsed.findings[0].severity, 'minor');
  assert.equal(parsed.verdict, 'needs-fix');
  assert.deepEqual(parsed.humanAttention, []);

  const empty = parseReviewerOutput('{"verdict":"pass"}');
  assert.deepEqual(empty.findings, []);
  assert.deepEqual(empty.humanAttention, []);
  assert.equal(empty.verdict, 'pass');
});

test('prompts: parseReviewerOutput reports schemaError on invalid output', () => {
  for (const bad of ['', 'that is not json at all', '```json\n{broken}\n```', '[]']) {
    const parsed = parseReviewerOutput(bad);
    assert.equal(typeof parsed.schemaError, 'string');
    assert.ok(parsed.schemaError.length > 0);
  }
});

test('prompts: buildFilterPrompt is conservative and parseFilterOutput is lenient', () => {
  const findings = [{ ...FINDING_A, fingerprint: computeFingerprint(FINDING_A) }];
  const prompt = buildFilterPrompt({
    unit: { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A, newLineCount: 3 }] },
    findings,
  });
  assert.ok(prompt.system.includes('keep'));
  assert.ok(prompt.user.includes(computeFingerprint(FINDING_A)));
  assert.ok(prompt.user.includes('证据不足') || prompt.user.includes('保守'));

  const parsed = parseFilterOutput(
    '说明\n```json\n[{"fingerprint":"abc","decision":"drop","reason":"diff 中没有该代码"},{"fingerprint":"def","decision":"KEEP"},{"fingerprint":"ghi","decision":"maybe"}]\n```',
  );
  assert.equal(parsed.schemaError, undefined);
  assert.deepEqual(
    parsed.decisions.map((decision) => decision.decision),
    ['drop', 'keep', 'keep'],
  );

  assert.equal(typeof parseFilterOutput('nonsense').schemaError, 'string');
});

/* ------------------------------------------------------------------------- */
/* position                                                                  */
/* ------------------------------------------------------------------------- */

test('position: existing_code hit gets real new-file lines', () => {
  const unit = {
    unitId: 'u01',
    files: [{ path: 'src/a.js', patch: PATCH_A, newLineCount: 3 }],
  };
  const anchored = anchorOne({ file: 'src/a.js', existing_code: 'const b = 2;', line: 2 }, unit);
  assert.equal(anchored.anchored, true);
  assert.equal(anchored.startLine, 2);
  assert.equal(anchored.endLine, 2);

  const multi = anchorOne(
    { file: 'src/a.js', existing_code: 'const a = 1;\nconst b = 2;' },
    unit,
  );
  assert.equal(multi.anchored, true);
  assert.equal(multi.startLine, 1);
  assert.equal(multi.endLine, 2);
});

test('position: whitespace-normalized existing_code also matches', () => {
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const anchored = anchorOne({ file: 'src/a.js', existing_code: '   const   b =   2;  ' }, unit);
  assert.equal(anchored.anchored, true);
  assert.equal(anchored.startLine, 2);
});

test('position: line is clamped to the new-line set', () => {
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const anchored = anchorOne({ file: 'src/a.js', line: 99, category: 'correctness' }, unit);
  assert.equal(anchored.anchored, true);
  assert.equal(anchored.startLine, 3);
  assert.equal(anchored.endLine, 3);
  assert.equal(anchored.anchorReason, 'line-clamped');
});

test('position: file outside the unit is out-of-scope', () => {
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const anchored = anchorOne({ file: 'src/other.js', line: 4 }, unit);
  assert.equal(anchored.anchored, false);
  assert.equal(anchored.anchorReason, 'out-of-scope');
  assert.equal(anchored.startLine, null);
  assert.equal(anchored.endLine, null);
});

test('position: a file with no new lines cannot be anchored (miss)', () => {
  const deletionOnly = [
    'diff --git a/src/gone.js b/src/gone.js',
    '--- a/src/gone.js',
    '+++ b/src/gone.js',
    '@@ -1,2 +0,0 @@',
    '-const gone = 1;',
    '-const gone2 = 2;',
    '',
  ].join('\n');
  const unit = { unitId: 'u01', files: [{ path: 'src/gone.js', patch: deletionOnly }] };
  const anchored = anchorOne({ file: 'src/gone.js', existing_code: 'const gone = 1;' }, unit);
  assert.equal(anchored.anchored, false);
  assert.equal(anchored.startLine, null);
  assert.equal(anchored.endLine, null);
  assert.equal(typeof anchored.anchorReason, 'string');
});

test('position: falls back to the hunk range, and content mode finds off-diff snippets', () => {
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const byHunk = anchorOne({ file: 'src/a.js', category: 'correctness' }, unit);
  assert.equal(byHunk.anchored, true);
  assert.equal(byHunk.startLine, 1);
  assert.equal(byHunk.endLine, 3);
  assert.equal(byHunk.anchorReason, 'hunk-range');

  const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
  const contentUnit = {
    unitId: 'u02',
    files: [{ path: 'src/big.js', content, patch: '' }],
  };
  const hit = anchorOne(
    { file: 'src/big.js', existing_code: 'line 42\nline 43', line: 42 },
    contentUnit,
  );
  assert.equal(hit.anchored, true);
  assert.equal(hit.startLine, 42);
  assert.equal(hit.endLine, 43);

  const normalized = anchorOne(
    { file: 'src/big.js', existing_code: '  line   42  ', line: 45 },
    contentUnit,
  );
  assert.equal(normalized.anchored, true);
  assert.equal(normalized.startLine, 42);
});

/* ------------------------------------------------------------------------- */
/* aggregate                                                                 */
/* ------------------------------------------------------------------------- */

function finding(over = {}) {
  return {
    file: 'src/a.js',
    category: 'correctness',
    severity: 'major',
    problem: 'Null deref on b',
    evidence: 'b is used before assignment in the new code path',
    impact: 'runtime crash',
    suggestion: 'guard b before use',
    anchored: true,
    startLine: 10,
    endLine: 10,
    preexisting: false,
    ...over,
  };
}

function review(lens, findings, unitId = 'u01') {
  return { unitId, lens, round: 1, findings, usage: usage() };
}

const AGG_CONFIG = {
  review: { maxComments: 30, votesForMajor: 2 },
  gate: { blockOn: ['blocker', 'major'], blockPreexisting: false },
};

test('aggregate: cross-lens votes keep major and create a blocking finding', () => {
  const anchored = [
    { ...finding(), lens: 'correctness' },
    { ...finding(), lens: 'security' },
  ];
  const result = aggregateFindings({ reviews: [review('correctness', []), review('security', [])], anchored, config: AGG_CONFIG });
  assert.equal(result.findings.length, 1);
  const merged = result.findings[0];
  assert.equal(merged.votes, 2);
  assert.deepEqual(merged.lenses, ['correctness', 'security']);
  assert.equal(merged.severity, 'major');
  assert.equal(merged.status, 'real');
  assert.equal(merged.blocking, true);
  assert.equal(merged.fingerprint.length, 40);
  assert.match(merged.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(result.counts.major, 1);
  assert.equal(result.verdict, 'block');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].file, 'src/a.js');
});

test('aggregate: insufficient votes downgrade major/blocker to minor', () => {
  const anchored = [{ ...finding(), lens: 'correctness' }];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  const merged = result.findings[0];
  assert.equal(merged.severity, 'minor');
  assert.equal(merged.downgradedFrom, 'major');
  assert.equal(merged.blocking, false);
  assert.equal(result.verdict, 'pass');
});

test('aggregate: empty evidence becomes needs-human (never swallowed)', () => {
  const anchored = [
    { ...finding({ evidence: '' }), lens: 'correctness' },
    { ...finding({ evidence: '' }), lens: 'security' },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings[0].status, 'needs-human');
  assert.equal(result.findings[0].needsHuman, true);
  assert.equal(result.counts.needsHuman, 1);
  assert.equal(result.verdict, 'needs-human');
});

test('aggregate: preexisting findings are non-blocking unless configured', () => {
  const anchored = [
    { ...finding({ preexisting: true }), lens: 'correctness' },
    { ...finding({ preexisting: true }), lens: 'security' },
  ];
  const normal = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(normal.findings[0].preexisting, true);
  assert.equal(normal.findings[0].status, 'real');
  assert.equal(normal.findings[0].blocking, false);
  assert.equal(normal.verdict, 'pass');

  const blockingConfig = {
    ...AGG_CONFIG,
    gate: { ...AGG_CONFIG.gate, blockPreexisting: true },
  };
  const blocked = aggregateFindings({ reviews: [], anchored, config: blockingConfig });
  assert.equal(blocked.findings[0].blocking, true);
  assert.equal(blocked.verdict, 'block');
  assert.equal(blockingFindings(blocked, blockingConfig).length, 1);
});

test('aggregate: style/docs minor findings are dropped', () => {
  const anchored = [
    { ...finding({ category: 'style', severity: 'minor', problem: '命名风格' }), lens: 'correctness' },
    { ...finding({ category: 'style', severity: 'minor', problem: '命名风格' }), lens: 'security' },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings[0].status, 'dropped');
  assert.equal(result.findings[0].dropReason, 'style-minor');
  assert.equal(result.counts.dropped, 1);
  assert.equal(result.verdict, 'pass');
});

test('aggregate: unit-scope "no tests" observation is dropped (P-2 noise)', () => {
  const anchored = [
    {
      ...finding({
        category: 'tests',
        severity: 'minor',
        problem: '本评审单元没有任何配套测试文件',
        evidence: 'unit 内只有 lib/gateway.js，没有 test/ 文件',
      }),
      lens: 'tests',
    },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings[0].status, 'dropped');
  assert.equal(result.findings[0].dropReason, 'unit-scope-test-gap');
  assert.equal(result.counts.dropped, 1);
  assert.equal(result.verdict, 'pass');
});

test('aggregate: a specific test assertion gap is still reported', () => {
  const anchored = [
    {
      ...finding({
        category: 'tests',
        severity: 'minor',
        problem: '失败路径的断言缺失：consume 的 409 分支没有任何断言',
        evidence: 'consume 在 consumed 状态抛 409，但测试只断言了成功路径',
      }),
      lens: 'tests',
    },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings[0].status, 'real');
  assert.equal(result.counts.dropped, 0);
});

test('aggregate: cross-lens duplicates on the same line merge into one finding', () => {
  const anchored = [
    {
      ...finding({
        category: 'concurrency',
        severity: 'minor',
        startLine: 250,
        problem: '_cluster_drawings 对单页所有 drawings 做 O(n²) 两两相交判定，没有数量上限',
      }),
      lens: 'concurrency',
    },
    {
      ...finding({
        category: 'security',
        severity: 'minor',
        startLine: 250,
        problem: '_cluster_drawings 对单页所有 drawings 做 O(n²) 两两相交判定，n 由 PDF 内容流决定且没有上限',
      }),
      lens: 'security',
    },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  const atLine = result.findings.filter((item) => item.startLine === 250);
  assert.equal(atLine.length, 1, 'the same issue is not reported twice under two categories');
  assert.equal(atLine[0].votes, 2, 'lens votes are unioned');
  assert.deepEqual(atLine[0].mergedCategories.sort(), ['concurrency', 'security']);
});

test('aggregate: different issues on the same line stay separate', () => {
  const anchored = [
    {
      ...finding({
        category: 'security',
        severity: 'minor',
        startLine: 250,
        problem: 'unbounded O(n^2) intersection scan over attacker controlled drawings',
      }),
      lens: 'security',
    },
    {
      ...finding({
        category: 'errors',
        severity: 'minor',
        startLine: 250,
        problem: 'debug logging writes extracted PDF text to stderr',
      }),
      lens: 'errors',
    },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings.filter((item) => item.startLine === 250).length, 2);
});

test('aggregate: maxComments trims real findings but keeps needs-human', () => {
  const anchored = [
    { ...finding({ startLine: 10 }), lens: 'correctness' },
    { ...finding({ startLine: 10 }), lens: 'security' },
    { ...finding({ startLine: 20, problem: 'Second bug', severity: 'minor' }), lens: 'correctness' },
    { ...finding({ startLine: 20, problem: 'Second bug', severity: 'minor' }), lens: 'security' },
    { ...finding({ startLine: 30, problem: 'Unproven risk', evidence: '' }), lens: 'intent' },
  ];
  const config = { ...AGG_CONFIG, review: { ...AGG_CONFIG.review, maxComments: 1 } };
  const result = aggregateFindings({ reviews: [], anchored, config });
  const real = result.findings.filter((item) => item.status === 'real');
  const human = result.findings.filter((item) => item.status === 'needs-human');
  const dropped = result.findings.filter((item) => item.dropReason === 'max-comments');
  assert.equal(real.length, 1);
  assert.equal(real[0].severity, 'major');
  assert.equal(human.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(result.counts.major, 1);
  assert.equal(result.counts.needsHuman, 1);
});

test('aggregate: same-lens duplicates dedupe without inflating votes', () => {
  const anchored = [
    { ...finding(), lens: 'correctness' },
    { ...finding(), lens: 'correctness' },
  ];
  const result = aggregateFindings({ reviews: [], anchored, config: AGG_CONFIG });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].votes, 1);
  assert.equal(result.findings[0].occurrences, 2);
  assert.equal(result.findings[0].severity, 'minor');
});

test('aggregate: fingerprints are deterministic sha1 over normalized fields', () => {
  const a = computeFingerprint({ file: 'src/a.js', category: 'correctness', problem: 'A  b', startLine: 3, endLine: 4 });
  const b = computeFingerprint({ file: 'src\\a.js', category: 'correctness', problem: 'a b', startLine: 3, endLine: 4 });
  assert.equal(a, b);
  assert.equal(a.length, 40);
  assert.notEqual(a, computeFingerprint({ ...finding(), startLine: 99 }));
});

test('aggregate: reviewer failures make the verdict needs-human', () => {
  const result = aggregateFindings({
    reviews: [
      { unitId: 'u01', lens: 'intent', findings: [], usage: usage(), humanAttention: ['确认配置项'] },
      { unitId: 'u01', lens: 'security', findings: [], usage: usage(), error: { code: 'LLM_SERVER', message: 'boom' } },
    ],
    anchored: [],
    config: AGG_CONFIG,
  });
  assert.equal(result.verdict, 'needs-human');
  assert.equal(result.humanAttention.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'LLM_SERVER');
});

test('aggregate: human attention alone does not block (minor findings still pass)', () => {
  const result = aggregateFindings({
    reviews: [
      { unitId: 'u01', lens: 'intent', findings: [], usage: usage(), humanAttention: ['确认配置项'] },
    ],
    anchored: [finding({ severity: 'minor', lens: 'intent' })],
    config: AGG_CONFIG,
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.humanAttention.length, 1);
  assert.equal(result.counts.minor, 1);
});

/* ------------------------------------------------------------------------- */
/* filter                                                                    */
/* ------------------------------------------------------------------------- */

test('filter: LLM failure keeps every finding', async () => {
  const findings = [
    { ...finding(), fingerprint: computeFingerprint(finding()) },
    { ...finding({ startLine: 20, problem: 'Other' }), fingerprint: computeFingerprint(finding({ startLine: 20, problem: 'Other' })) },
  ];
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const llm = { complete: async () => { throw Object.assign(new Error('down'), { code: 'LLM_SERVER' }); } };
  const result = await filterFindings({ unit, findings, llm, config: { review: { filter: true } } });
  assert.equal(result.filterUsed, false);
  assert.deepEqual(result.findings, findings);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.error.code, 'LLM_SERVER');
});

test('filter: invalid filter JSON keeps every finding', async () => {
  const findings = [{ ...finding(), fingerprint: computeFingerprint(finding()) }];
  const unit = { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] };
  const llm = { complete: async () => completion('totally not json') };
  const result = await filterFindings({ unit, findings, llm, config: { review: { filter: true } } });
  assert.equal(result.filterUsed, false);
  assert.deepEqual(result.findings, findings);
  assert.equal(typeof result.schemaError, 'string');
});

test('filter: only reasoned drops are honoured; everything else is kept', async () => {
  const keptFinding = finding();
  const droppedFinding = finding({ startLine: 20, problem: 'Phantom issue' });
  const fingerprintKept = computeFingerprint(keptFinding);
  const fingerprintDropped = computeFingerprint(droppedFinding);
  const findings = [
    { ...keptFinding, fingerprint: fingerprintKept },
    { ...droppedFinding, fingerprint: fingerprintDropped },
    { ...finding({ startLine: 40, problem: 'No decision' }), fingerprint: computeFingerprint(finding({ startLine: 40, problem: 'No decision' })) },
  ];
  const llm = {
    complete: async () =>
      completion(
        JSON.stringify([
          { fingerprint: fingerprintKept, decision: 'drop', reason: '' },
          { fingerprint: fingerprintDropped, decision: 'drop', reason: '该代码不在本 diff 中' },
        ]),
      ),
  };
  const result = await filterFindings({
    unit: { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] },
    findings,
    llm,
    config: { review: { filter: true } },
  });
  assert.equal(result.filterUsed, true);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.some((item) => item.fingerprint === fingerprintKept));
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].fingerprint, fingerprintDropped);
  assert.equal(result.dropped[0].filterReason, '该代码不在本 diff 中');
});

test('filter: disabled by config and backfills missing fingerprints', async () => {
  const llmCalls = [];
  const llm = { complete: async () => { llmCalls.push(1); return completion('[]'); } };
  const raw = [{ ...finding() }];
  const disabled = await filterFindings({
    unit: { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] },
    findings: raw,
    llm,
    config: { review: { filter: false } },
  });
  assert.equal(disabled.filterUsed, false);
  assert.equal(llmCalls.length, 0);
  assert.equal(disabled.findings.length, 1);
  assert.equal(typeof disabled.findings[0].fingerprint, 'string');

  const enabled = await filterFindings({
    unit: { unitId: 'u01', files: [{ path: 'src/a.js', patch: PATCH_A }] },
    findings: raw,
    llm,
    config: { review: { filter: true } },
  });
  assert.equal(enabled.filterUsed, true);
  assert.equal(enabled.findings.length, 1);
});

/* ------------------------------------------------------------------------- */
/* report + SARIF                                                            */
/* ------------------------------------------------------------------------- */

function reportFixture() {
  const anchoredBlocker = {
    fingerprint: 'a'.repeat(40),
    file: 'src/a.js',
    startLine: 10,
    endLine: 12,
    anchored: true,
    category: 'security',
    severity: 'blocker',
    problem: '命令注入',
    evidence: 'exec(userInput)',
    impact: 'RCE',
    suggestion: '校验输入',
    status: 'real',
    blocking: true,
    votes: 2,
    lenses: ['security', 'correctness'],
    preexisting: false,
  };
  const anchoredPreexisting = {
    fingerprint: 'b'.repeat(40),
    file: 'src/b.js',
    startLine: 3,
    endLine: 3,
    anchored: true,
    category: 'tests',
    severity: 'major',
    problem: '缺少失败路径测试',
    evidence: '新增分支无测试',
    impact: '回归风险',
    suggestion: '补测试',
    status: 'real',
    blocking: false,
    votes: 2,
    lenses: ['tests'],
    preexisting: true,
  };
  const anchoredMinor = {
    fingerprint: 'e'.repeat(40),
    file: 'src/e.js',
    startLine: 7,
    endLine: 7,
    anchored: true,
    category: 'correctness',
    severity: 'minor',
    problem: '边界条件可简化',
    evidence: '冗余判断',
    impact: '可读性',
    suggestion: '改为 >=',
    status: 'real',
    blocking: false,
    votes: 1,
    lenses: ['intent'],
    preexisting: false,
  };
  const needsHuman = {
    fingerprint: 'c'.repeat(40),
    file: 'src/c.js',
    startLine: null,
    endLine: null,
    anchored: false,
    anchorReason: 'out-of-scope',
    category: 'correctness',
    severity: 'minor',
    problem: '未锚定问题',
    evidence: 'x',
    impact: 'y',
    suggestion: 'z',
    status: 'needs-human',
    needsHuman: true,
    blocking: false,
    votes: 1,
    lenses: ['intent'],
    preexisting: false,
  };
  const dropped = {
    fingerprint: 'd'.repeat(40),
    file: 'src/d.js',
    startLine: 5,
    endLine: 5,
    anchored: true,
    category: 'style',
    severity: 'minor',
    problem: '风格',
    evidence: 'x',
    status: 'dropped',
    dropReason: 'style-minor',
    votes: 1,
    lenses: ['intent'],
    preexisting: false,
  };
  return {
    aggregate: {
      schemaVersion: 1,
      findings: [anchoredBlocker, anchoredPreexisting, anchoredMinor, needsHuman, dropped],
      counts: { blocker: 1, major: 1, minor: 1, needsHuman: 1, dropped: 1 },
      verdict: 'block',
      blocking: [
        {
          fingerprint: anchoredBlocker.fingerprint,
          file: 'src/a.js',
          startLine: 10,
          severity: 'blocker',
          title: '命令注入',
        },
      ],
      humanAttention: ['确认配置默认值'],
      errors: [],
    },
    scope: {
      schemaVersion: 1,
      runId: 'run-test',
      mode: 'workspace',
      files: [
        { path: 'src/a.js', status: 'modified', insertions: 3, deletions: 1, reviewable: true, excludeReason: null },
        { path: 'src/lock.lock', status: 'added', insertions: 1, deletions: 0, reviewable: false, excludeReason: 'default_path' },
      ],
      counts: { total: 2, reviewable: 1, excluded: 1, insertions: 4, deletions: 1 },
      coverage: { complete: true, unreviewed: [] },
    },
    plan: {
      schemaVersion: 1,
      runId: 'run-test',
      effort: 'standard',
      lenses: ['security'],
      units: [
        {
          unitId: 'u01',
          files: [{ path: 'src/a.js', patch: PATCH_A, newLineCount: 3 }],
          rules: [],
          lenses: ['security'],
          stats: { changedLines: 3, files: 1 },
        },
      ],
      skippedFiles: [{ path: 'src/lock.lock', reason: 'default_path' }],
    },
    gate: {
      schemaVersion: 1,
      checks: [
        { id: 'test', cmd: 'npm test', exit: 0, durationMs: 12, stdoutTail: '', required: true, skipped: false },
      ],
      verdict: 'fail',
      blocking: [
        {
          fingerprint: 'a'.repeat(40),
          file: 'src/a.js',
          startLine: 10,
          severity: 'blocker',
          title: '命令注入',
        },
      ],
      exitCode: 2,
    },
    meta: {
      runId: 'run-test',
      version: '0.1.0',
      calls: 3,
      durationMs: 1234,
      startedAt: '2026-11-16T00:00:00.000Z',
      finishedAt: '2026-11-16T00:00:02.000Z',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      model: {
        transport: 'anthropic',
        model: 'deepseek-flash',
        effort: 'max',
        baseUrlHost: 'api.example.test',
      },
      apiKey: 'sk-abcdefghijklmnopqrstuvwx',
    },
  };
}

test('report: writes md/json/sarif and the SARIF structure is valid', (t) => {
  const runDir = tempDir(t);
  const fixture = reportFixture();
  const paths = writeReports({
    runDir,
    scope: fixture.scope,
    plan: fixture.plan,
    aggregate: fixture.aggregate,
    gate: fixture.gate,
    meta: fixture.meta,
  });
  assert.deepEqual(Object.keys(paths).sort(), ['json', 'md', 'sarif']);
  for (const file of Object.values(paths)) {
    assert.ok(file.startsWith(runDir), `${file} should be inside ${runDir}`);
    assert.ok(readFileSync(file, 'utf8').length > 0);
  }

  const markdown = readFileSync(paths.md, 'utf8');
  for (const heading of ['## 结论', '## 阻断项', '## 需人工判断', '## 非阻断', '## 覆盖清单', '## 门禁', '## 成本统计']) {
    assert.ok(markdown.includes(heading), `report.md missing ${heading}`);
  }
  assert.ok(markdown.includes('命令注入'));
  assert.ok(markdown.includes('未锚定问题'));

  const json = JSON.parse(readFileSync(paths.json, 'utf8'));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.runId, 'run-test');
  assert.equal(json.aggregate.verdict, 'block');
  assert.equal(json.gate.exitCode, 2);
  assert.equal(json.scope.mode, 'workspace');
  assert.ok(!readFileSync(paths.json, 'utf8').includes('sk-abcdefghijklmnopqrstuvwx'), 'API key must not be written');
  assert.ok(!readFileSync(paths.md, 'utf8').includes('sk-abcdefghijklmnopqrstuvwx'));

  const sarif = JSON.parse(readFileSync(paths.sarif, 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(typeof sarif.$schema, 'string');
  assert.ok(Array.isArray(sarif.runs));
  assert.equal(sarif.runs.length, 1);
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'dsh-code-reviewer');
  assert.ok(Array.isArray(run.tool.driver.rules));
  assert.ok(Array.isArray(run.results));

  const ruleIds = new Set(run.tool.driver.rules.map((rule) => rule.id));
  for (const rule of run.tool.driver.rules) {
    assert.equal(typeof rule.id, 'string');
    assert.equal(typeof rule.shortDescription.text, 'string');
  }
  for (const result of run.results) {
    assert.ok(ruleIds.has(result.ruleId), `result ruleId ${result.ruleId} must be declared in rules`);
    assert.equal(typeof result.message.text, 'string');
    const physical = result.locations[0].physicalLocation;
    assert.equal(typeof physical.artifactLocation.uri, 'string');
    assert.ok(Number.isInteger(physical.region.startLine));
    assert.ok(physical.region.startLine >= 1);
  }
  const uriByFingerprint = new Map(
    run.results.map((result) => [result.partialFingerprints.dshFingerprint, result.locations[0].physicalLocation.artifactLocation.uri]),
  );
  assert.equal(uriByFingerprint.get('a'.repeat(40)), 'src/a.js');
  assert.equal(uriByFingerprint.get('b'.repeat(40)), 'src/b.js');
  assert.equal(uriByFingerprint.get('e'.repeat(40)), 'src/e.js');
  assert.equal(uriByFingerprint.has('c'.repeat(40)), false, 'unanchored findings must not enter SARIF');
  assert.equal(uriByFingerprint.has('d'.repeat(40)), false, 'dropped findings must not enter SARIF');

  const levels = Object.fromEntries(
    run.results.map((result) => [result.partialFingerprints.dshFingerprint, result.level]),
  );
  assert.equal(levels['a'.repeat(40)], 'error');
  assert.equal(levels['b'.repeat(40)], 'warning');
  assert.equal(levels['e'.repeat(40)], 'note');
});

/* ------------------------------------------------------------------------- */
/* runReview                                                                 */
/* ------------------------------------------------------------------------- */

function planWithUnits(unitCount = 2, lenses = ['intent', 'correctness']) {
  const units = [];
  for (let index = 0; index < unitCount; index += 1) {
    units.push({
      unitId: `u0${index + 1}`,
      files: [{ path: `src/f${index + 1}.js`, patch: PATCH_A, newLineCount: 3 }],
      rules: [],
      lenses,
      stats: { changedLines: 3, files: 1 },
    });
  }
  return { schemaVersion: 1, runId: 'run-test', effort: 'deep', lenses, units, skippedFiles: [] };
}

test('runReview: runs one call per (unit,lens) and totals usage/calls', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(2, ['intent', 'correctness']);
  const calls = [];
  const llm = {
    complete: async () => {
      calls.push(1);
      return completion(reviewerJson({ findings: [FINDING_A] }));
    },
  };
  const result = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 2, maxComments: 5 } },
    llm,
    cwd,
    log: () => {},
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.reviews.length, 4);
  assert.equal(result.calls, 4);
  assert.equal(calls.length, 4);
  assert.equal(result.usage.inputTokens, 4 * 10);
  assert.equal(result.usage.outputTokens, 4 * 5);
  assert.equal(result.usage.cacheReadTokens, 4 * 1);
  assert.equal(result.usage.cacheWriteTokens, 4 * 2);
  assert.equal(typeof result.startedAt, 'string');
  assert.equal(typeof result.finishedAt, 'string');
  assert.ok(result.durationMs >= 0);
  for (const entry of result.reviews) {
    assert.equal(entry.findings.length, 1);
    assert.equal(entry.findings[0].lens, entry.lens);
  }
});

test('runReview: a single reviewer failure is recorded and the run continues', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(1, ['intent', 'correctness']);
  const llm = {
    complete: async (req) => {
      if (req.user.includes('"id": "correctness"')) {
        throw Object.assign(new Error('upstream exploded'), { code: 'LLM_SERVER' });
      }
      return completion(reviewerJson({ findings: [FINDING_A] }));
    },
  };
  const result = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 1 } },
    llm,
    cwd,
    log: () => {},
  });
  assert.equal(result.reviews.length, 2);
  const failed = result.reviews.find((entry) => entry.lens === 'correctness');
  const succeeded = result.reviews.find((entry) => entry.lens === 'intent');
  assert.equal(failed.error.code, 'LLM_SERVER');
  assert.match(failed.error.message, /upstream exploded/);
  assert.deepEqual(failed.findings, []);
  assert.equal(succeeded.error, undefined);
  assert.equal(succeeded.findings.length, 1);
});

test('runReview: schema errors retry up to the attempt budget, then yield a needs-human finding', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(1, ['intent']);

  const retrying = { count: 0 };
  const llmRetry = {
    complete: async () => {
      retrying.count += 1;
      if (retrying.count === 1) return completion('not json at all');
      return completion(reviewerJson({ findings: [FINDING_A] }));
    },
  };
  const recovered = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 1 } },
    llm: llmRetry,
    cwd,
    log: () => {},
  });
  assert.equal(retrying.count, 2);
  assert.equal(recovered.reviews[0].schemaError, undefined);
  assert.equal(recovered.reviews[0].findings.length, 1);
  assert.equal(recovered.calls, 2);

  const llmBroken = { complete: async () => completion('still not json') };
  const broken = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 1 } },
    llm: llmBroken,
    cwd,
    log: () => {},
  });
  const entry = broken.reviews[0];
  assert.equal(typeof entry.schemaError, 'string');
  assert.equal(entry.findings.length, 1);
  assert.equal(entry.findings[0].needsHuman, true);
  assert.equal(entry.findings[0].evidence, '');
  assert.equal(entry.calls, 3, 'schema failures use the full attempt budget');
});

test('runReview: round 2 reviews only previously-confirmed findings / affected files', async (t) => {
  const cwd = tempDir(t);
  const plan = {
    schemaVersion: 1,
    runId: 'run-test',
    effort: 'deep',
    rounds: 2,
    lenses: ['intent', 'correctness'],
    units: [
      {
        unitId: 'u01',
        files: [
          { path: 'src/a.js', patch: PATCH_A, newLineCount: 3 },
          { path: 'src/b.js', patch: PATCH_A, newLineCount: 3 },
        ],
        rules: [],
        lenses: ['intent', 'correctness'],
        stats: { changedLines: 6, files: 2 },
      },
    ],
    skippedFiles: [],
  };
  const round1Users = [];
  const round2Users = [];
  const llm = {
    complete: async (req) => {
      if (req.user.includes('round2-verify')) {
        round2Users.push(req.user);
        return completion(reviewerJson({ findings: [FINDING_A], verdict: 'needs-fix' }));
      }
      round1Users.push(req.user);
      return completion(reviewerJson({ findings: [FINDING_A], verdict: 'needs-fix' }));
    },
  };
  const result = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 1, votesForMajor: 2 } },
    llm,
    cwd,
    log: () => {},
  });
  assert.equal(result.rounds, 2, 'plan.rounds=2 (effort=deep) must trigger round 2');
  assert.equal(round1Users.length, 2);
  assert.equal(round2Users.length, 2);
  const round2Reviews = result.reviews.filter((entry) => entry.round === 2);
  assert.equal(round2Reviews.length, 2);
  for (const user of round2Users) {
    assert.ok(user.includes('priorFindings'), 'round 2 prompt must include priorFindings');
    assert.ok(user.includes('src/a.js'));
  }
  assert.equal(result.calls, 4);
});

test('runReview: no units or missing llm behaves predictably', async (t) => {
  const cwd = tempDir(t);
  const empty = await runReview({
    scope: {},
    plan: { schemaVersion: 1, units: [], lenses: ['intent'] },
    config: {},
    llm: { complete: async () => completion(reviewerJson()) },
    cwd,
    log: () => {},
  });
  assert.equal(empty.rounds, 0);
  assert.deepEqual(empty.reviews, []);
  assert.equal(empty.calls, 0);

  await assert.rejects(
    () => runReview({ scope: {}, plan: planWithUnits(1, ['intent']), config: {}, llm: null, cwd }),
    (err) => err.code === 'CONFIG',
  );
});

test('runReview: reviewer requests pin temperature 0 by default and honor an override', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(1, ['intent']);
  const temperatures = [];
  const llm = {
    complete: async (req) => {
      temperatures.push(req.temperature);
      return completion(reviewerJson());
    },
  };
  await runReview({ scope: {}, plan, config: {}, llm, cwd, log: () => {} });
  assert.deepEqual(temperatures, [0], 'default temperature keeps repeated runs reproducible');
  temperatures.length = 0;
  await runReview({ scope: {}, plan, config: { review: { temperature: 0.4 } }, llm, cwd, log: () => {} });
  assert.deepEqual(temperatures, [0.4]);
});

test('runReview: transient LLM errors are retried before giving up', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(1, ['intent']);
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('transport down'), { code: 'LLM_SERVER' });
      return completion(reviewerJson({ findings: [FINDING_A], verdict: 'needs-fix' }));
    },
  };
  const result = await runReview({ scope: {}, plan, config: {}, llm, cwd, log: () => {} });
  assert.equal(calls, 2, 'a transient failure is retried once');
  assert.equal(result.reviews[0].error, undefined);
  assert.equal(result.reviews[0].findings.length, 1);
});

test('runReview: persistent transport failure stops after the retry budget', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(1, ['intent']);
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      throw Object.assign(new Error('still down'), { code: 'LLM_SERVER' });
    },
  };
  const result = await runReview({ scope: {}, plan, config: {}, llm, cwd, log: () => {} });
  assert.equal(calls, 3);
  assert.equal(result.reviews[0].error.code, 'LLM_SERVER');
});

test('runReview: scan-mode findings are marked pre-existing so they cannot block a gate', async (t) => {
  const cwd = tempDir(t);
  const llm = {
    complete: async () => completion(reviewerJson({ findings: [FINDING_A], verdict: 'needs-fix' })),
  };
  const scanPlan = { ...planWithUnits(1, ['intent']), mode: 'scan' };
  const scanRun = await runReview({ scope: {}, plan: scanPlan, config: {}, llm, cwd, log: () => {} });
  assert.equal(scanRun.reviews[0].findings[0].preexisting, true);

  const diffPlan = { ...scanPlan, mode: 'workspace' };
  const diffRun = await runReview({ scope: {}, plan: diffPlan, config: {}, llm, cwd, log: () => {} });
  assert.equal(diffRun.reviews[0].findings[0].preexisting, false);
});

test('runReview: concurrency is bounded by config.review.concurrency', async (t) => {
  const cwd = tempDir(t);
  const plan = planWithUnits(4, ['intent', 'correctness']);
  let active = 0;
  let maxActive = 0;
  const llm = {
    complete: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return completion(reviewerJson());
    },
  };
  const result = await runReview({
    scope: {},
    plan,
    config: { review: { concurrency: 2 } },
    llm,
    cwd,
    log: () => {},
  });
  assert.equal(result.reviews.length, 8);
  assert.ok(maxActive <= 2, `max in-flight LLM calls was ${maxActive}, expected <= 2`);
  assert.equal(maxActive, 2, 'the worker pool should actually fill the concurrency window');
});

/* ------------------------------------------------------------------------- */
/* llm transport (stubbed fetch, no network)                                 */
/* ------------------------------------------------------------------------- */

test('llm: resolves baseUrl from env and cwd/.env, and never duplicates /v1', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const urls = [];
  const headers = [];
  const sse = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const fromEnv = createLlm({
    model: { transport: 'anthropic' },
    cwd,
    env: { DEEPSEEK_BASE_URL: 'https://env.example.test/anthropic', DEEPSEEK_API_KEY: 'k' },
  });
  assert.equal(fromEnv.describe().baseUrlHost, 'env.example.test');

  writeFileSync(
    join(cwd, '.env'),
    'DEEPSEEK_BASE_URL=https://dotenv.example.test/anthropic/v1\nDEEPSEEK_API_KEY=dotenv-key\n',
    'utf8',
  );
  const fromDotenv = createLlm({ model: { transport: 'anthropic' }, cwd, env: {} });
  assert.equal(fromDotenv.describe().baseUrlHost, 'dotenv.example.test');
  await fromDotenv.complete({ system: 's', user: 'u' });
  assert.equal(urls[0], 'https://dotenv.example.test/anthropic/v1/messages');
  assert.equal(headers[0]['x-api-key'], 'dotenv-key');

  // `model.baseUrl` wins over env, trailing slashes stripped, /v1 not duplicated.
  const explicit = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://explicit.example.test/anthropic/v1/' },
    cwd,
    env: { DEEPSEEK_BASE_URL: 'https://env.example.test/anthropic', DEEPSEEK_API_KEY: 'k' },
  });
  await explicit.complete({ system: 's', user: 'u' });
  assert.equal(urls[1], 'https://explicit.example.test/anthropic/v1/messages');
});

test('llm: req.maxTokens overrides the default max_tokens', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(
      ['data: {"type":"message_stop"}', ''].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const llm = createLlm({
    model: { transport: 'anthropic', maxTokens: 2048 },
    cwd,
    env: { DEEPSEEK_API_KEY: 'k' },
  });
  await llm.complete({ system: 's', user: 'u', maxTokens: 123 });
  assert.equal(body.max_tokens, 123);
  await llm.complete({ system: 's', user: 'u' });
  assert.equal(body.max_tokens, 2048, 'model.maxTokens is the fallback');
});

test('llm: idle timeout maps to LLM_TIMEOUT (retried, then rejected)', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let attempts = 0;
  globalThis.fetch = (url, init) => {
    attempts += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted by timeout'), { name: 'AbortError' }));
      });
    });
  };
  const llm = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://llm.example.test/anthropic' },
    cwd,
    env: {
      DEEPSEEK_API_KEY: 'k',
      REVIEW_LLM_TIMEOUT_MS: '40',
      REVIEW_LLM_RETRY_DELAYS: '1,1',
    },
  });
  await assert.rejects(
    () => llm.complete({ system: 's', user: 'u' }),
    (err) => err.code === 'LLM_TIMEOUT',
  );
  assert.equal(attempts, 3, 'timeouts are retried 2 times before failing');
});

test('llm: describe never exposes the key and resolves host/effort', (t) => {
  const cwd = tempDir(t);
  const llm = createLlm({
    model: {
      transport: 'anthropic',
      baseUrl: 'https://llm.example.test/anthropic',
      reasoningEffort: 'max',
    },
    cwd,
    env: { DEEPSEEK_API_KEY: 'super-secret-key-value' },
  });
  const described = llm.describe();
  assert.deepEqual(described, {
    transport: 'anthropic',
    model: 'deepseek-flash',
    effort: 'max',
    baseUrlHost: 'llm.example.test',
  });
  assert.ok(!JSON.stringify(described).includes('super-secret-key-value'));
});

test('llm: anthropic transport streams SSE text/usage and builds the contract request', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let captured = null;
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"deepseek-flash","usage":{"input_tokens":12,"cache_read_input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7,"cache_creation_input_tokens":2}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init?.headers, body: JSON.parse(init.body) };
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const llm = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://llm.example.test/anthropic/' },
    cwd,
    env: { DEEPSEEK_API_KEY: 'test-key' },
  });
  const result = await llm.complete({ system: 'sys', user: 'usr' });
  assert.equal(captured.url, 'https://llm.example.test/anthropic/v1/messages');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.headers['x-api-key'], 'test-key');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.equal(captured.body.max_tokens, 256000);
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.deepEqual(captured.body.output_config, { effort: 'max' });
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'usr' }] }]);
  assert.equal(captured.body.system, 'sys');
  assert.equal(result.text, 'hello world');
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.effort, 'max');
});

test('llm: openai transport appends /v1/chat/completions and parses delta content', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let captured = null;
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init?.headers, body: JSON.parse(init.body) };
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const llm = createLlm({
    model: { transport: 'openai', baseUrl: 'https://llm.example.test/v1', reasoningEffort: 'high' },
    cwd,
    env: { DEEPSEEK_API_KEY: 'openai-key' },
  });
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(captured.url, 'https://llm.example.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer openai-key');
  assert.equal(captured.body.reasoning_effort, 'high');
  assert.equal(captured.body.stream, true);
  assert.equal(result.text, 'hi there');
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(result.usage.outputTokens, 2);
});

test('llm: maps HTTP errors to contract error codes', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const llm = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://llm.example.test/anthropic' },
    cwd,
    env: { DEEPSEEK_API_KEY: 'test-key', REVIEW_LLM_RETRY_DELAYS: '1,1' },
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('invalid key', { status: 401 });
  };
  await assert.rejects(
    () => llm.complete({ system: 's', user: 'u' }),
    (err) => err.code === 'LLM_AUTH',
  );
  assert.equal(fetchCalls, 1, '4xx must not be retried');

  globalThis.fetch = async () => new Response('server down', { status: 503 });
  await assert.rejects(
    () => llm.complete({ system: 's', user: 'u' }),
    (err) => err.code === 'LLM_SERVER',
  );
});

test('llm: retries 5xx twice with backoff and succeeds on the third attempt', async (t) => {
  const cwd = tempDir(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  const sse = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls < 3) return new Response('temporary', { status: 500 });
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const llm = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://llm.example.test/anthropic' },
    cwd,
    env: { DEEPSEEK_API_KEY: 'test-key', REVIEW_LLM_RETRY_DELAYS: '1,1' },
  });
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(fetchCalls, 3);
  assert.equal(result.text, 'ok');
});

test('llm: missing API key fails with LLM_AUTH and never prints the key name value', async (t) => {
  const cwd = tempDir(t);
  const llm = createLlm({
    model: { transport: 'anthropic', baseUrl: 'https://llm.example.test/anthropic' },
    cwd,
    env: {},
  });
  await assert.rejects(
    () => llm.complete({ system: 's', user: 'u' }),
    (err) => err.code === 'LLM_AUTH' && !err.message.includes('sk-'),
  );
});
