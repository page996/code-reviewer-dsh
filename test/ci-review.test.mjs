/**
 * Tests for the CI review workbench (plugins/ci-review).
 *
 * Two layers:
 *   1. lib/review-model.mjs — pure vote/grouping/coverage/convergence rules.
 *   2. plugins/ci-review/index.js — the Host half driven through its real HTTP
 *      route with a fake Cordis context and fake subagents (no network, no DSH).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The plugin resolves its cache/bridge paths from DSH_HOME at import time, so
// isolate it before the dynamic import.
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-review-home-'));
process.env.DSH_HOME = DSH_HOME;
process.env.GITHUB_TOKEN = '';
process.env.GH_TOKEN = '';

const plugin = await import('../plugins/ci-review/index.js');
const model = await import('../plugins/ci-review/lib/review-model.mjs');

const ROUTE = '/dsh-ci-review';

after(() => {
  fs.rmSync(DSH_HOME, { recursive: true, force: true });
});

/* ------------------------------------------------------------- pure model */

test('vote aggregation requires a real majority and grades severity by vote', () => {
  const verifier = (verdict, severity = null) => ({ status: 'completed', verdict, severity, reason: 'r' });

  const unanimous = model.aggregateVotes([
    verifier('confirmed', 'major'), verifier('confirmed', 'major'), verifier('confirmed', 'minor'),
  ]);
  assert.equal(unanimous.verdict, 'confirmed');
  assert.equal(unanimous.confidence, 'high');
  assert.deepEqual(unanimous.votes, { confirmed: 3, rejected: 0, uncertain: 0, pending: 0, failed: 0, total: 3 });
  assert.equal(unanimous.gradedSeverity, 'major');

  const majority = model.aggregateVotes([
    verifier('confirmed', 'minor'), verifier('confirmed', 'minor'), verifier('rejected'),
  ]);
  assert.equal(majority.verdict, 'confirmed');
  assert.equal(majority.confidence, 'medium');
  assert.equal(majority.votes.confirmed, 2);

  const rejected = model.aggregateVotes([
    verifier('rejected'), verifier('rejected'), verifier('confirmed', 'blocker'),
  ]);
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.gradedSeverity, null, 'severity is only meaningful for confirmed problems');

  const split = model.aggregateVotes([
    verifier('confirmed'), verifier('rejected'), verifier('uncertain'),
  ]);
  assert.equal(split.verdict, 'uncertain');
  assert.equal(split.confidence, 'low');

  const pending = model.aggregateVotes([
    verifier('confirmed'), { status: 'running', verdict: null }, { status: 'running', verdict: null },
  ]);
  assert.equal(pending.verdict, null, 'a running verifier must not produce a conclusion');
  assert.equal(pending.votes.pending, 2);

  const failed = model.aggregateVotes([
    { status: 'failed', verdict: null, reason: 'boom' }, { status: 'failed', verdict: null, reason: 'boom' },
  ]);
  assert.equal(failed.verdict, null);
  assert.equal(failed.votes.failed, 2);
  assert.match(failed.reason, /失败/);

  const single = model.aggregateVotes([verifier('confirmed', 'major')]);
  assert.equal(single.verdict, 'confirmed');
  assert.equal(single.confidence, 'low', 'one verifier is never high confidence');
  assert.equal(model.normalizeVerifierCount(null, 3), 3, 'null keeps the configured verifier count');
  assert.equal(model.normalizeVerifierCount('', 3), 3);
  assert.equal(model.normalizeVerifierCount(1, 3), 1);
  assert.equal(model.normalizeVerifierCount(99, 3), 5, 'verifier count is capped');
  assert.equal(model.normalizeConvergeMax(99, 3), 10, 'convergence batch size is capped');
  assert.equal(model.normalizeConvergeMax(undefined, 3), 3);
});

test('legacy single-verifier records normalize into a one-vote verifier', () => {
  const legacy = model.normalizeVerificationRecord({
    status: 'completed', verdict: 'confirmed', reason: '旧记录', confidence: 'medium',
  });
  assert.equal(legacy.verdict, 'confirmed');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.votes.total, 1);
  assert.equal(legacy.verifiers[0].stance, 'legacy');
  assert.equal(model.normalizeVerificationRecord(null), null);
});

test('agent grouping maps finding keys, detects stale signatures and keeps leftovers', () => {
  const findings = [
    { file: 'a.js', startLine: 10, severity: 'major', category: 'errors', title: 'A', revision: 'r1' },
    { file: 'a.js', startLine: 11, severity: 'minor', category: 'errors', title: 'B', revision: 'r1' },
    { file: 'b.js', startLine: 5, severity: 'blocker', category: 'security', title: 'C', revision: 'r1' },
  ];
  const keys = model.keyFindings(findings).map((entry) => entry.key);
  const signature = model.findingsSignature(findings);
  const grouping = {
    id: 'grouping-1',
    headSha: 'head',
    status: 'completed',
    signature,
    generatedAt: new Date().toISOString(),
    groups: [
      { id: 'g1', title: '同一根因', phase: 'impact', severity: 'major', collapsed: false, findingKeys: [keys[0], keys[1]] },
      { id: 'g2', title: '安全', phase: 'core', severity: 'blocker', findingKeys: [keys[2], 'ghost#1#x#y'] },
    ],
  };
  const resolved = model.groupFindingsByAgent({ findings, grouping, headSha: 'head' });
  assert.equal(resolved.applied, true);
  assert.equal(resolved.groups.length, 2);
  assert.equal(resolved.groups[0].findings.length, 2);
  assert.equal(resolved.groups[1].findings.length, 1);
  assert.equal(resolved.stats.unknownKeys, 1);
  assert.equal(resolved.ungroupedFindings.length, 0);

  const stale = model.groupFindingsByAgent({ findings, grouping: { ...grouping, signature: 'deadbeef' }, headSha: 'head' });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'findings-changed');
  assert.equal(stale.ungroupedFindings.length, 3, 'stale grouping falls back without dropping findings');

  const missingGrouping = model.groupFindingsByAgent({ findings, grouping: null });
  assert.equal(missingGrouping.applied, false);
  assert.equal(missingGrouping.reason, 'no-grouping');
});

test('coverage separates reviewed / excluded / unknown evidence', () => {
  const evidence = {
    fresh: { 'a.js': true },
    revisions: { 'a.js': 'head', 'b.js': 'old' },
    excluded: { 'data.json': 'secret_exclude' },
  };
  const coverage = model.coverageForBatch({
    files: ['a.js'],
    linkedFiles: ['b.js', 'data.json'],
    cards: [{ file: 'c.js', stale: null }],
    evidence,
  });
  assert.deepEqual(coverage.reviewed, ['a.js']);
  assert.deepEqual(coverage.excluded, ['data.json']);
  assert.equal(coverage.excludedDetails[0].reason, 'secret_exclude');
  assert.ok(coverage.unknown.includes('b.js'));
  assert.ok(coverage.unknown.includes('c.js'));

  const overlapping = model.coverageForBatch({
    files: ['a.js'],
    linkedFiles: [],
    cards: [{ file: 'a.js', stale: null }],
    evidence: { fresh: { 'a.js': true }, revisions: { 'a.js': 'head' }, excluded: {} },
  });
  assert.deepEqual(overlapping.reviewed, ['a.js']);
  assert.deepEqual(overlapping.unknown, [], 'a HEAD-reviewed file cannot also be unknown');
  assert.equal(overlapping.unknownDetails.length, 0);

  const project = model.buildProjectCoverage({
    batches: [
      { stale: true, staleUnknown: false, coverage: { files: ['a.js'], linkedFiles: ['b.js'] } },
      { stale: false, staleUnknown: true, coverage: { files: ['b.js'], linkedFiles: [] } },
    ],
    headSha: 'head',
    evidence,
  });
  assert.equal(project.freshFiles, 1);
  assert.equal(project.unknownFiles, 1, 'b.js is related but not fresh');
  assert.equal(project.excludedFiles, 1);
  assert.equal(project.staleBatches, 1);
  assert.equal(project.staleUnknownBatches, 1);
});

test('re-review planning prioritises stale blockers and respects the file cap', () => {
  const batches = [
    { stale: true, staleUnknown: false, cards: [{ file: 'a.js', severity: 'major' }] },
    { stale: false, staleUnknown: true, cards: [{ file: 'b.js', severity: 'blocker' }] },
    { stale: false, staleUnknown: false, cards: [{ file: 'c.js', severity: 'minor' }] },
  ];
  const jobs = [
    { file: 'c.js', status: 'completed', headSha: 'head', finishedAt: '2026-01-01T00:00:00.000Z' },
    { file: 'a.js', status: 'completed', headSha: 'old', finishedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const plan = model.planReReview({ batches, jobs, headSha: 'head', maxFiles: 1 });
  assert.equal(plan.totals.batches, 3);
  assert.equal(plan.totals.stale, 1);
  assert.equal(plan.totals.unknown, 1);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].file, 'b.js', 'blocker file comes first');
  assert.equal(plan.truncated, true);

  const planAll = model.planReReview({ batches, jobs, headSha: 'head', maxFiles: 5 });
  assert.deepEqual(planAll.files.map((entry) => entry.file), ['b.js', 'a.js']);
  assert.equal(planAll.files.some((entry) => entry.file === 'c.js'), false, 'fresh file is not re-reviewed');
});

/* ------------------------------------------------------- plugin harness */

function projectIdFor(root) {
  return createHash('sha256')
    .update(String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-review-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i};`).join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), Array.from({ length: 30 }, (_, i) => `export const b${i} = ${i};`).join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'data.json'), '{"secret":true}\n', 'utf8');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'ci-review@example.test');
  git('config', 'user.name', 'ci review test');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const headSha = git('rev-parse', 'HEAD').trim();

  fs.mkdirSync(path.join(root, '.review', 'ci-review', 'review-jobs'), { recursive: true });
  const oldSha = '1111111111111111111111111111111111111111';
  const writeJob = (id, file, findings) => {
    fs.writeFileSync(path.join(root, '.review', 'ci-review', 'review-jobs', `${id}.json`), `${JSON.stringify({
      id, file, headSha: oldSha, lenses: ['correctness'], status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z',
      results: { correctness: { status: 'completed', findings } },
    }, null, 2)}\n`, 'utf8');
  };
  writeJob('job-20260101-000001-aaaaaa', 'src/a.js', [{
    file: 'src/a.js', startLine: 5, endLine: 6, severity: 'major', category: 'errors',
    title: 'A 问题', problem: 'a 的问题描述', evidence: '参考 src/data.json', impact: 'i', suggestion: 's',
  }]);
  writeJob('job-20260101-000002-bbbbbb', 'src/b.js', [{
    file: 'src/b.js', startLine: 8, endLine: 9, severity: 'blocker', category: 'security',
    title: 'B 问题', problem: 'b 的问题描述', evidence: 'e', impact: 'i', suggestion: 's',
  }]);

  fs.mkdirSync(path.join(root, '.review', 'runs', 'run-20260101-000000-dead'), { recursive: true });
  fs.writeFileSync(path.join(root, '.review', 'runs', 'run-20260101-000000-dead', 'scope.json'), JSON.stringify({
    schemaVersion: 1,
    runId: 'run-20260101-000000-dead',
    mode: 'scan',
    files: [
      { path: 'src/a.js', reviewable: true, excludeReason: null },
      { path: 'src/b.js', reviewable: true, excludeReason: null },
      { path: 'src/data.json', reviewable: false, excludeReason: 'secret_exclude' },
    ],
    counts: { total: 3, reviewable: 2, excluded: 1 },
    coverage: { complete: false, unreviewed: ['src/data.json'] },
  }), 'utf8');
  fs.writeFileSync(path.join(root, '.review', 'config.json'), JSON.stringify({
    gate: { commands: [] },
    ciReview: { verifiers: 3, convergeMaxFiles: 3 },
  }, null, 2), 'utf8');
  return { root, headSha };
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headersSent = true;
      Object.assign(res.headers, headers ?? {});
    },
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.body += String(chunk);
    },
  };
  return res;
}

function fakeRequest({ method, url, body }) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:9999', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    destroy() {},
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return req;
    },
    start() {
      if (body !== undefined) for (const handler of listeners.get('data') ?? []) handler(Buffer.from(JSON.stringify(body)));
      for (const handler of listeners.get('end') ?? []) handler();
    },
  };
  return req;
}

function createHarness({ projectRoot, projectName = 'fixture' }) {
  const routes = [];
  const activationCalls = [];
  const state = {
    reportFactory: () => ({ findings: [] }),
    holdResults: false,
    rejectResults: false,
  };
  const services = new Map();
  const logger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
  services.set('logger', logger);
  services.set('workspaceRegistry', { list: () => [{ path: projectRoot, title: projectName }] });
  services.set('agents', { list: () => [{ id: 'agent-root' }] });
  services.set('sessionQuery', {
    listSessions: async () => [],
    readSession: async () => ({ header: { cwd: projectRoot } }),
  });
  services.set('subagents', {
    rootOf: (agent) => ({ id: agent.id }),
    startActivation: async (spec) => {
      activationCalls.push(spec);
      const report = state.reportFactory(String(spec.label ?? ''), spec, activationCalls.length);
      const result = state.holdResults
        ? new Promise(() => {})
        : state.rejectResults
          ? Promise.reject(new Error('fake verifier failure'))
          : Promise.resolve({
            output: [{ type: 'text', text: JSON.stringify(report) }],
            stopReason: { kind: 'completed' },
          });
      return {
        childId: `child-${activationCalls.length}`,
        dispose() {},
        result,
      };
    },
  });
  const ctx = {
    get(name) {
      return services.get(name);
    },
    effect(setup) {
      const disposer = setup();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
      tapIndex(html) {
        return html;
      },
    },
  };
  plugin.apply(ctx, {
    refreshSeconds: 1,
    projects: [{ name: projectName, root: projectRoot }],
  });
  const handler = routes.find((route) => route.path === ROUTE)?.handler;
  assert.equal(typeof handler, 'function', 'ci-review route registered');

  async function call(method, apiPath, body) {
    const req = fakeRequest({ method, url: `${ROUTE}${apiPath}`, body });
    const res = fakeResponse();
    const pending = handler(req, res);
    req.start();
    await pending;
    let json = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = { raw: res.body };
    }
    return { status: res.statusCode, json };
  }

  return {
    call,
    activationCalls,
    state,
    projectId: projectIdFor(projectRoot),
    async snapshot() {
      await call('POST', `/api/refresh?projectId=${encodeURIComponent(projectIdFor(projectRoot))}`);
      const result = await call('GET', `/api/snapshot?projectId=${encodeURIComponent(projectIdFor(projectRoot))}`);
      assert.equal(result.status, 200, `snapshot status ${result.status}: ${result.json?.error ?? ''}`);
      return result.json;
    },
  };
}

async function waitFor(check, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out${lastError ? `: ${lastError.message}` : ''}`);
}

/* ------------------------------------------------- plugin integration */

test('snapshot exposes grouping source, real coverage and a convergence plan', async (t) => {
  const { root, headSha } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  const snapshot = await harness.snapshot();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.project.headSha, headSha.slice(0, 12));
  assert.equal(snapshot.reviewBatches.length, 2, 'heuristic fallback clusters per file');
  assert.equal(snapshot.reviewGrouping.source, 'heuristic');
  assert.equal(snapshot.reviewGrouping.applied, false);

  const batchA = snapshot.reviewBatches.find((batch) => batch.coverage.files.includes('src/a.js'));
  assert.ok(batchA, 'a.js batch exists');
  assert.deepEqual(batchA.coverage.excluded, ['src/data.json']);
  assert.equal(batchA.coverage.excludedDetails[0].reason, 'secret_exclude');
  assert.ok(batchA.coverage.unknown.length >= 1, 'stale file is reported as unknown');
  assert.equal(batchA.cards[0].stale, true, 'old revision is stale at HEAD');

  assert.equal(snapshot.reviewCoverage.excludedFiles, 1);
  assert.ok(snapshot.reviewCoverage.excluded.some((entry) => entry.file === 'src/data.json'));
  assert.equal(snapshot.reviewCoverage.convergence.totals.batches, 2);
  assert.equal(snapshot.reviewCoverage.convergence.totals.stale, 2);
  assert.ok(snapshot.reviewCoverage.convergence.candidates >= 2);
  assert.equal(snapshot.reviewCoverage.convergence.files[0].file, 'src/b.js', 'blocker file is re-reviewed first');
  assert.equal(snapshot.capabilities.verifiers, 3);
});

test('multi-verifier verify endpoint records votes and aggregates the verdict', async (t) => {
  const { root } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  let verifyCalls = 0;
  harness.state.reportFactory = (label) => {
    if (label.startsWith('verify v')) {
      verifyCalls += 1;
      if (verifyCalls === 1) return { verdict: 'confirmed', severity: 'major', reason: '调用方可达', evidenceFor: ['src/b.js:8'], confidence: 'high' };
      if (verifyCalls === 2) return { verdict: 'confirmed', severity: 'major', reason: '测试未覆盖', evidenceFor: ['src/b.js:8'], confidence: 'medium' };
      return { verdict: 'rejected', reason: '上游已校验', evidenceAgainst: ['src/b.js:9'], confidence: 'high' };
    }
    return { findings: [] };
  };

  const snapshot = await harness.snapshot();
  const batch = snapshot.reviewBatches[0];
  assert.equal(batch.severity, 'blocker');
  const result = await harness.call('POST', `/api/review-problems/verify?projectId=${encodeURIComponent(harness.projectId)}`, {
    verifiers: 3,
    problem: {
      id: batch.problemId,
      problemKey: batch.problemId,
      file: batch.coverage.files[0],
      startLine: batch.cards[0].startLine,
      severity: batch.severity,
      category: batch.category,
      title: batch.title,
      problem: batch.explanation.what,
      evidence: batch.explanation.evidence,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.verifiers, 3);
  assert.equal(harness.activationCalls.filter((call) => String(call.label).startsWith('verify v')).length, 3);

  const settled = await waitFor(async () => {
    const current = await harness.snapshot();
    const target = current.reviewBatches.find((entry) => entry.problemId === batch.problemId);
    return target?.verification?.status === 'completed' ? target.verification : null;
  });
  assert.equal(settled.verdict, 'confirmed');
  assert.equal(settled.confidence, 'medium');
  assert.deepEqual(settled.votes, { confirmed: 2, rejected: 1, uncertain: 0, pending: 0, failed: 0, total: 3 });
  assert.equal(settled.gradedSeverity, 'major');
  assert.equal(settled.verifiers.length, 3);
  assert.deepEqual(settled.verifiers.map((entry) => entry.stance), ['contradict', 'context', 'evidence']);
  assert.match(settled.reason, /2\/3/);
});

test('grouping endpoint rebuilds batches from the agent logical stages', async (t) => {
  const { root } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  const before = await harness.snapshot();
  const keys = model.keyFindings(before.findings).map((entry) => entry.key);
  assert.equal(keys.length, 2);
  harness.state.reportFactory = (label) => {
    if (label.startsWith('group ')) {
      return {
        groups: [{
          id: 'stage-1',
          title: '两个问题同属一个安全决策面',
          phase: 'impact',
          // Adversarial output: the group claims minor + collapsed although the
          // batch contains a blocker. Severity/collapse must not hide it.
          severity: 'minor',
          collapsed: true,
          decisionPrompt: '是否在调用边界统一校验？',
          rationale: '共享同一输入边界',
          explanation: { what: 'w', whyImportant: 'y', evidence: 'e', uncertainty: 'u' },
          coverage: { excluded: ['src/data.json'], unknown: [] },
          findingKeys: keys,
        }],
        coverage: { excluded: [], unknown: [] },
        notes: '分组完成',
      };
    }
    return { findings: [] };
  };

  const started = await harness.call('POST', `/api/review-problems/group?projectId=${encodeURIComponent(harness.projectId)}`, {});
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);

  const snapshot = await waitFor(async () => {
    const current = await harness.snapshot();
    return current.reviewGrouping?.source === 'agent' ? current : null;
  });
  assert.equal(snapshot.reviewBatches.length, 1, 'agent decides the batch count');
  const batch = snapshot.reviewBatches[0];
  assert.equal(batch.phase, 'impact');
  assert.equal(batch.title, '两个问题同属一个安全决策面');
  assert.equal(batch.grouping.source, 'agent');
  assert.equal(batch.grouping.decisionPrompt, '是否在调用边界统一校验？');
  assert.equal(batch.severity, 'blocker', 'a grouping cannot downgrade a blocker to minor');
  assert.equal(batch.collapsed, false, 'a batch containing non-minor cards must not be collapsed');
  assert.equal(batch.cards.length, 2);
  assert.ok(batch.coverage.excluded.includes('src/data.json'));
  assert.match(snapshot.reviewGrouping.notes, /分组完成/);

  // Findings change after a new review job: the grouping signature no longer
  // matches, so the panel must fall back to heuristic and flag the stale grouping.
  const jobsDir = path.join(root, '.review', 'ci-review', 'review-jobs');
  fs.writeFileSync(path.join(jobsDir, 'job-20260101-000003-cccccc.json'), `${JSON.stringify({
    id: 'job-20260101-000003-cccccc', file: 'src/a.js', headSha: '1111111111111111111111111111111111111111',
    lenses: ['correctness'], status: 'completed',
    startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:00:05.000Z',
    results: { correctness: { status: 'completed', findings: [{
      file: 'src/a.js', startLine: 20, endLine: 21, severity: 'minor', category: 'style',
      title: '新增问题', problem: 'p', evidence: 'e', impact: 'i', suggestion: 's',
    }] } },
  }, null, 2)}\n`, 'utf8');
  const afterChange = await waitFor(async () => {
    const current = await harness.snapshot();
    return current.reviewGrouping?.stale === true ? current : null;
  });
  assert.equal(afterChange.reviewGrouping.source, 'heuristic');
  assert.equal(afterChange.reviewGrouping.hasGrouping, true);
  assert.equal(afterChange.reviewGrouping.reason, 'findings-changed');
});

test('convergence endpoint plans first and starts a HEAD review job on demand', async (t) => {
  const { root, headSha } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  harness.state.reportFactory = () => ({ findings: [] });

  const dryRun = await harness.call('POST', `/api/review-job/converge?projectId=${encodeURIComponent(harness.projectId)}`, { start: false, maxFiles: 99 });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.json.ok, true);
  assert.equal(dryRun.json.started, false);
  assert.equal(dryRun.json.plan.files.length, 2);
  assert.equal(dryRun.json.plan.maxFiles, 3, 'requested maxFiles is capped by ciReview.convergeMaxFiles');
  assert.equal(harness.activationCalls.length, 0, 'dry run starts no subagents');

  const started = await harness.call('POST', `/api/review-job/converge?projectId=${encodeURIComponent(harness.projectId)}`, { maxFiles: 1, lenses: ['correctness'] });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.started, true);
  assert.equal(started.json.jobs.length, 1);
  assert.deepEqual(started.json.jobs[0].lenses, ['correctness'], 'requested lenses reach the review job');
  assert.equal(harness.activationCalls.filter((call) => String(call.label).startsWith('review-')).length, 1);

  const jobFiles = fs.readdirSync(path.join(root, '.review', 'ci-review', 'review-jobs')).sort();
  const jobs = jobFiles.map((name) => JSON.parse(fs.readFileSync(path.join(root, '.review', 'ci-review', 'review-jobs', name), 'utf8')));
  const freshJob = jobs.find((job) => job.headSha === headSha);
  assert.ok(freshJob, `a review job recorded at HEAD (${headSha})`);
  assert.equal(freshJob.file, 'src/b.js');

  const completed = await waitFor(async () => {
    const current = await harness.snapshot();
    const job = current.reviewJobs.find((entry) => entry.id === freshJob.id);
    return job?.status === 'completed' ? current : null;
  });
  assert.ok(completed.reviewJobs.some((job) => job.id === freshJob.id), 'new job is visible in the snapshot');
  const remaining = completed.reviewCoverage.convergence.files.map((entry) => entry.file);
  assert.equal(remaining.includes('src/b.js'), false, 'a file reviewed at HEAD stops being a convergence candidate');
});

/* ------------------------------------------------- adversarial / compat */

test('verify endpoint cannot be downgraded by the request body', async (t) => {
  const { root } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  harness.state.reportFactory = (label) => (String(label).startsWith('verify v')
    ? { verdict: 'confirmed', severity: 'minor', reason: 'ok', confidence: 'high' }
    : { findings: [] });
  const snapshot = await harness.snapshot();
  const batch = snapshot.reviewBatches[0];
  const result = await harness.call('POST', `/api/review-problems/verify?projectId=${encodeURIComponent(harness.projectId)}`, {
    verifiers: 1,
    problem: { problemKey: batch.problemId, id: batch.problemId, file: batch.coverage.files[0], startLine: 1, severity: 'minor', title: batch.title, problem: 'p' },
  });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.verifiers, 3, 'server uses ciReview.verifiers, not the client value');
  assert.equal(harness.activationCalls.filter((call) => String(call.label).startsWith('verify v')).length, 3);
});

test('a second verify request is rejected while one is still running', async (t) => {
  const { root } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  harness.state.holdResults = true;
  const snapshot = await harness.snapshot();
  const batch = snapshot.reviewBatches[0];
  const problem = { problemKey: batch.problemId, id: batch.problemId, file: batch.coverage.files[0], startLine: 1, severity: batch.severity, title: batch.title, problem: 'p' };
  const first = await harness.call('POST', `/api/review-problems/verify?projectId=${encodeURIComponent(harness.projectId)}`, { problem });
  assert.equal(first.json.ok, true);
  assert.equal(first.json.verification.status, 'running');
  const second = await harness.call('POST', `/api/review-problems/verify?projectId=${encodeURIComponent(harness.projectId)}`, { problem });
  assert.equal(second.json.ok, false);
  assert.match(second.json.message, /已.*运行/);
});

test('legacy v1 verification records still render on heuristic batches', async (t) => {
  const { root } = makeProject(t);
  fs.writeFileSync(path.join(root, '.review', 'ci-review', 'verifications.json'), `${JSON.stringify({
    version: 1,
    byProblem: {
      'problem-1-security': { status: 'completed', verdict: 'confirmed', severity: 'blocker', reason: '旧版单验证者记录', confidence: 'medium' },
    },
  }, null, 2)}\n`, 'utf8');
  const harness = createHarness({ projectRoot: root });
  const snapshot = await harness.snapshot();
  const batch = snapshot.reviewBatches.find((entry) => entry.coverage.files.includes('src/b.js'));
  assert.ok(batch);
  assert.equal(batch.verification.legacy, true);
  assert.equal(batch.verification.verdict, 'confirmed');
  assert.equal(batch.verification.votes.total, 1);
  assert.match(batch.verification.reason, /旧版单验证者记录|确认/);
});

test('all verifiers failing marks the verification failed (not completed)', async (t) => {
  const { root } = makeProject(t);
  const harness = createHarness({ projectRoot: root });
  harness.state.rejectResults = true;
  const snapshot = await harness.snapshot();
  const batch = snapshot.reviewBatches[0];
  await harness.call('POST', `/api/review-problems/verify?projectId=${encodeURIComponent(harness.projectId)}`, {
    problem: { problemKey: batch.problemId, id: batch.problemId, file: batch.coverage.files[0], startLine: 1, severity: batch.severity, title: batch.title, problem: 'p' },
  });
  const failed = await waitFor(async () => {
    const current = await harness.snapshot();
    const target = current.reviewBatches.find((entry) => entry.problemId === batch.problemId);
    return target?.verification?.status === 'failed' ? target.verification : null;
  });
  assert.equal(failed.votes.failed, 3);
  assert.equal(failed.verdict, null);
  assert.match(failed.reason, /失败/);
});
