/**
 * Host-plugin tests for plugins/dsh/index.js.
 *
 * Uses a fake Cordis-like ctx, a temp non-git workspace and a fake
 * ctx.llm.stream (no network). The deterministic engine in ../../lib is real:
 * these tests exercise the same pipeline the CLI uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as plugin from '../plugins/dsh/index.js';

const TOOL_NAMES = ['review_scope', 'review_plan', 'review_run', 'review_gate', 'review_report', 'review_ledger'];

const TOOL_PARAMS = {
  review_scope: ['base', 'head', 'mode', 'path', 'repo'],
  review_plan: ['effort', 'repo', 'runId'],
  review_run: ['effort', 'lenses', 'repo', 'rounds', 'runId'],
  review_gate: ['repo', 'runId'],
  review_report: ['format', 'repo', 'runId'],
  review_ledger: ['action', 'repo', 'runId'],
};

const ADD_SOURCE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

const REVIEWER_OUTPUT = {
  findings: [
    {
      file: 'src/add.ts',
      existing_code: '  return a + b;',
      line: 2,
      category: 'correctness',
      severity: 'blocker',
      problem: '返回值未经检查，可能把类型错误传播给调用方',
      evidence: '函数签名声明返回 number，但表达式依赖运行时类型',
      impact: '错误输入会静默产生 NaN 或字符串拼接',
      suggestion: '增加输入校验或显式类型收窄',
      preexisting: false,
    },
  ],
  verdict: 'needs-fix',
  human_attention: [],
};

function reviewerText() {
  return JSON.stringify(REVIEWER_OUTPUT);
}

function createFakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.body += String(chunk);
    },
  };
  return res;
}

function createHarness({ cwd, webServer = null, omitTools = false, omitCommands = false, omitLlm = false } = {}) {
  const tools = new Map();
  const commands = new Map();
  const routes = [];
  const llmCalls = [];
  const logs = [];
  const services = new Map();

  const toolRegistry = {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };
  const commandRegistry = {
    register(definition) {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  };

  const llm = {
    stream(options) {
      llmCalls.push(options);
      const text = reviewerText();
      return (async function* fakeStream() {
        yield { type: 'text-delta', index: 0, text };
        yield {
          type: 'usage',
          usage: { inputTokens: 120, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };

  const logger = {
    info(...args) {
      logs.push(['info', ...args]);
    },
    warn(...args) {
      logs.push(['warn', ...args]);
    },
    error(...args) {
      logs.push(['error', ...args]);
    },
    debug(...args) {
      logs.push(['debug', ...args]);
    },
  };

  services.set('workingDirectory', { defaultDirectory: cwd });
  services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' }),
  });
  if (webServer) {
    services.set('webServer', {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    });
  }

  const ctx = {
    tools: omitTools ? undefined : toolRegistry,
    commands: omitCommands ? undefined : commandRegistry,
    llm: omitLlm ? undefined : llm,
    logger,
    get(name) {
      return services.get(name);
    },
    effect(setup, _label) {
      const disposer = setup();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };

  const pluginConfig = {
    model: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' },
    review: { effort: 'quick', rounds: 1, concurrency: 2, filter: false },
    gate: { commands: [], autodetect: false },
  };

  return { ctx, tools, commands, routes, llmCalls, logs, pluginConfig };
}

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-plugin-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'add.ts'), ADD_SOURCE, 'utf8');
  return dir;
}

function fakeExec() {
  return { signal: new AbortController().signal };
}

async function callTool(harness, name, args, exec = fakeExec()) {
  const definition = harness.tools.get(name);
  assert.ok(definition, `tool ${name} is registered`);
  return definition.execute(args, exec);
}

function assertNoError(result, label) {
  assert.ok(!(result && result.error), `${label} returned an error: ${JSON.stringify(result && result.error)}`);
}

test('plugin exports the contract shape and registers 6 tools + /review command', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  assert.doesNotThrow(() => plugin.apply(harness.ctx, harness.pluginConfig));

  assert.equal(plugin.name, 'code-review');
  assert.deepEqual(plugin.inject, ['tools', 'commands', 'llm']);

  assert.deepEqual([...harness.tools.keys()].sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) {
    const definition = harness.tools.get(name);
    assert.equal(definition.name, name);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 20, `${name} has a meaningful description`);
    assert.ok(definition.parameters && typeof definition.parameters === 'object', `${name} parameters schema`);
    assert.equal(definition.parameters.type, 'object');
    assert.deepEqual(Object.keys(definition.parameters.properties).sort(), TOOL_PARAMS[name]);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(definition.output && typeof definition.output === 'object', `${name} output definition`);
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.schema.properties, 'object');
    assert.equal(typeof definition.output.render, 'function');
    const rendered = definition.output.render({}, { summary: `摘要：${name}` });
    assert.ok(Array.isArray(rendered) && rendered.length > 0);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /摘要/);
    assert.equal(typeof definition.execute, 'function');
    assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0);
    assert.equal(typeof definition.isConcurrencySafe, 'function');
    assert.equal(definition.isConcurrencySafe({}), false);
  }

  assert.ok(harness.commands.has('review'), '/review command registered');
  const command = harness.commands.get('review');
  assert.equal(command.name, 'review');
  assert.equal(typeof command.description, 'string');
  assert.ok(command.description.length >= 10);
  assert.equal(typeof command.handler, 'function');
  assert.ok(command.input && typeof command.input.hint === 'string');
});

test('review_scope on a non-git directory returns a scan scope', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  const result = await callTool(harness, 'review_scope', {});
  assertNoError(result, 'review_scope');
  assert.match(result.runId, /^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(result.mode, 'scan');
  assert.ok(result.counts.reviewable >= 1, `expected at least one reviewable file: ${JSON.stringify(result.counts)}`);
  assert.ok(result.fileCount >= 1);

  assert.equal(typeof result.artifacts.scope, 'string');
  const scopePath = path.join(cwd, result.artifacts.scope);
  assert.ok((await stat(scopePath)).isFile(), 'scope.json was written to the run directory');
  const scope = JSON.parse(await readFile(scopePath, 'utf8'));
  assert.equal(scope.schemaVersion, 1);
  assert.equal(scope.runId, result.runId);
  assert.equal(scope.mode, 'scan');
  const entry = scope.files.find((file) => file.path === 'src/add.ts');
  assert.ok(entry, 'src/add.ts is in scope.files');
  assert.equal(entry.reviewable, true);
  assert.equal(entry.status, 'existing');
});

test('review_plan + review_run with a fake llm produce aggregated findings', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  const scopeResult = await callTool(harness, 'review_scope', {});
  assertNoError(scopeResult, 'review_scope');

  const planResult = await callTool(harness, 'review_plan', { runId: scopeResult.runId, effort: 'quick' });
  assertNoError(planResult, 'review_plan');
  assert.equal(planResult.runId, scopeResult.runId);
  assert.ok(planResult.unitCount >= 1, 'at least one review unit');
  assert.ok(Array.isArray(planResult.lenses) && planResult.lenses.length >= 1);
  assert.ok(planResult.artifacts.plan.endsWith('plan.json'));
  assert.ok((await stat(path.join(cwd, planResult.artifacts.plan))).isFile(), 'plan.json was written');

  const runResult = await callTool(harness, 'review_run', { runId: scopeResult.runId });
  assertNoError(runResult, 'review_run');
  assert.equal(runResult.runId, scopeResult.runId);
  assert.ok(runResult.usage.calls >= 1, `usage.calls: ${JSON.stringify(runResult.usage)}`);
  assert.ok(runResult.usage.inputTokens > 0);
  assert.ok(['pass', 'block', 'needs-human'].includes(runResult.verdict));
  assert.ok(Number.isInteger(runResult.exitCode));
  assert.ok(harness.llmCalls.length >= 1, 'fake llm was called');
  assert.doesNotMatch(JSON.stringify(harness.llmCalls), /api[_-]?key|authorization|bearer/i);

  const aggregatePath = path.join(cwd, runResult.artifacts.aggregate);
  assert.ok((await stat(aggregatePath)).isFile(), 'aggregate.json was written');
  assert.ok((await stat(path.join(cwd, runResult.artifacts.findings))).isFile(), 'findings.json was written');
  const aggregate = JSON.parse(await readFile(aggregatePath, 'utf8'));
  assert.ok(Array.isArray(aggregate.findings));
  assert.ok(aggregate.findings.length >= 1, `expected findings, got ${JSON.stringify(aggregate.findings)}`);
  assert.ok(aggregate.findings.some((finding) => finding.file === 'src/add.ts'));
  const counts = runResult.counts;
  assert.ok(counts.blocker + counts.major + counts.minor + counts.needsHuman >= 1);

  // A gate run with no configured commands must not block or throw.
  const gateResult = await callTool(harness, 'review_gate', { runId: scopeResult.runId });
  assertNoError(gateResult, 'review_gate');
  assert.equal(gateResult.runId, scopeResult.runId);
  assert.ok(['pass', 'fail', 'needs-human', 'error'].includes(gateResult.verdict));
  assert.ok(Array.isArray(gateResult.blocking));
  assert.ok(Array.isArray(gateResult.checks));
  assert.ok(gateResult.artifacts.gate.endsWith('gate.json'));
  assert.ok((await stat(path.join(cwd, gateResult.artifacts.gate))).isFile(), 'gate.json was written');

  // Reports cover all three formats.
  const reportResult = await callTool(harness, 'review_report', { runId: scopeResult.runId, format: 'all' });
  assertNoError(reportResult, 'review_report');
  assert.deepEqual(reportResult.missing, []);
  for (const key of ['reportMd', 'reportJson', 'reportSarif']) {
    assert.equal(typeof reportResult.artifacts[key], 'string', `${key} artifact path`);
    assert.ok((await stat(path.join(cwd, reportResult.artifacts[key]))).isFile(), `${key} was written`);
  }

  const ledgerResult = await callTool(harness, 'review_ledger', { action: 'show', runId: scopeResult.runId });
  assertNoError(ledgerResult, 'review_ledger');
  assert.equal(ledgerResult.runId, scopeResult.runId);
  assert.ok(ledgerResult.totalFindings >= 1);
  assert.ok(Array.isArray(ledgerResult.findings) && ledgerResult.findings.length >= 1);
});

test('plugin loads without webServer, commands or tools services', async (t) => {
  const cwd = await makeWorkspace(t);
  const minimal = createHarness({ cwd, omitCommands: true });
  assert.doesNotThrow(() => plugin.apply(minimal.ctx, minimal.pluginConfig));
  assert.equal(minimal.commands.size, 0);
  assert.equal(minimal.tools.size, 6);
  assert.equal(minimal.routes.length, 0);

  // Tools still work without the command/webServer services.
  const scopeResult = await callTool(minimal, 'review_scope', {});
  assertNoError(scopeResult, 'review_scope without commands/webServer');

  const bare = createHarness({ cwd, omitTools: true, omitCommands: true, omitLlm: true });
  assert.doesNotThrow(() => plugin.apply(bare.ctx, bare.pluginConfig));
  assert.equal(bare.tools.size, 0);
});

test('tool failures are captured as {error:{code,message}} instead of throwing', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  // Unknown run id.
  const missingRun = await callTool(harness, 'review_plan', { runId: 'run-20260101-000000-dead' });
  assert.ok(missingRun.error, 'missing run returns an error payload');
  assert.equal(typeof missingRun.error.code, 'string');
  assert.ok(missingRun.error.code.length > 0);
  assert.equal(typeof missingRun.error.message, 'string');
  assert.ok(missingRun.error.message.length > 0);

  // Invalid mode is a USAGE error, not a throw.
  const badMode = await callTool(harness, 'review_scope', { mode: 'nonsense' });
  assert.ok(badMode.error);
  assert.equal(badMode.error.code, 'USAGE');

  // Report before review_run uses an empty aggregate (deterministic artifacts only).
  const scopeResult = await callTool(harness, 'review_scope', {});
  assertNoError(scopeResult, 'review_scope');
  const earlyReport = await callTool(harness, 'review_report', { runId: scopeResult.runId });
  assertNoError(earlyReport, 'review_report without review results');
  assert.deepEqual(earlyReport.missing, []);

  // Invalid ledger action is a USAGE error, not a throw.
  const badAction = await callTool(harness, 'review_ledger', { action: 'explode' });
  assert.ok(badAction.error);
  assert.equal(badAction.error.code, 'USAGE');

  // Missing llm service is reported, never fatal; the run still completes with zero calls.
  const noLlm = createHarness({ cwd, omitLlm: true });
  plugin.apply(noLlm.ctx, noLlm.pluginConfig);
  const noLlmScope = await callTool(noLlm, 'review_scope', {});
  assertNoError(noLlmScope, 'no-llm review_scope');
  const noLlmPlan = await callTool(noLlm, 'review_plan', { runId: noLlmScope.runId, effort: 'quick' });
  assertNoError(noLlmPlan, 'no-llm review_plan');
  const noLlmRun = await callTool(noLlm, 'review_run', { runId: noLlmScope.runId });
  assertNoError(noLlmRun, 'no-llm review_run');
  assert.equal(noLlmRun.usage.calls, 0);
  assert.equal(noLlm.llmCalls.length, 0);
});

test('webServer routes list runs and serve report.json read-only', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd, webServer: true });
  plugin.apply(harness.ctx, harness.pluginConfig);

  assert.equal(harness.routes.length, 2, 'exact list route + prefix report route');
  const listRoute = harness.routes.find((route) => route.kind === 'exact');
  const reportRoute = harness.routes.find((route) => route.kind === 'prefix');
  assert.ok(listRoute, 'exact /code-review/runs route');
  assert.ok(reportRoute, 'prefix /code-review/runs/ route');
  assert.equal(listRoute.path, '/code-review/runs');
  assert.equal(reportRoute.path, '/code-review/runs/');
  assert.equal(typeof listRoute.handler, 'function');
  assert.equal(typeof reportRoute.handler, 'function');

  const scopeResult = await callTool(harness, 'review_scope', {});
  assertNoError(scopeResult, 'review_scope');

  const listRes = createFakeRes();
  await listRoute.handler({ method: 'GET', url: '/code-review/runs?limit=5' }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.match(String(listRes.headers['content-type']), /application\/json/);
  const listBody = JSON.parse(listRes.body);
  assert.equal(listBody.schemaVersion, 1);
  assert.ok(Array.isArray(listBody.runs));
  assert.ok(listBody.runs.some((run) => run.runId === scopeResult.runId));
  assert.doesNotMatch(listRes.body, /[A-Za-z]:[\\/]/, 'no absolute Windows paths in the list payload');
  assert.doesNotMatch(listRes.body, /api[_-]?key/i);

  const missingRes = createFakeRes();
  await reportRoute.handler({ method: 'GET', url: `/code-review/runs/${scopeResult.runId}/report.json` }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.equal(typeof JSON.parse(missingRes.body).error.code, 'string');

  // A report.json inside the run directory is served verbatim.
  const runDirAbs = path.join(cwd, scopeResult.artifacts.runDir);
  await writeFile(path.join(runDirAbs, 'report.json'), JSON.stringify({ schemaVersion: 1, runId: scopeResult.runId, ok: true }), 'utf8');
  const servedRes = createFakeRes();
  await reportRoute.handler({ method: 'GET', url: `/code-review/runs/${scopeResult.runId}/report.json` }, servedRes);
  assert.equal(servedRes.statusCode, 200);
  assert.equal(JSON.parse(servedRes.body).ok, true);

  // Path traversal and bad method are rejected.
  const traversalRes = createFakeRes();
  await reportRoute.handler({ method: 'GET', url: '/code-review/runs/..%2F..%2Fetc/report.json' }, traversalRes);
  assert.equal(traversalRes.statusCode, 400);
  const methodRes = createFakeRes();
  await listRoute.handler({ method: 'POST', url: '/code-review/runs' }, methodRes);
  assert.equal(methodRes.statusCode, 405);
});

test('a run created with repo=... stays resolvable for later tools', async (t) => {
  const cwd = await makeWorkspace(t);
  const other = await mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-plugin-other-'));
  t.after(async () => {
    await rm(other, { recursive: true, force: true });
  });
  await mkdir(path.join(other, 'src'), { recursive: true });
  await writeFile(path.join(other, 'src', 'other.ts'), 'export const answer = 42;\n', 'utf8');

  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  const scopeResult = await callTool(harness, 'review_scope', { repo: other });
  assertNoError(scopeResult, 'review_scope repo=other');
  assert.equal(scopeResult.mode, 'scan');
  assert.ok((await stat(path.join(other, scopeResult.artifacts.scope))).isFile(), 'run lives under the target repo');

  const planResult = await callTool(harness, 'review_plan', { runId: scopeResult.runId, effort: 'quick' });
  assertNoError(planResult, 'review_plan on another repo run');
  const runResult = await callTool(harness, 'review_run', { runId: scopeResult.runId });
  assertNoError(runResult, 'review_run on another repo run');
  assert.equal(runResult.runId, scopeResult.runId);
});

test('/review command runs the full pipeline and returns a compact summary', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);
  const command = harness.commands.get('review');
  assert.ok(command);

  const result = await command.handler({
    commandId: 'cmd-1',
    agent: { id: 'agent-1' },
    rawInput: 'scan quick',
    attachments: [],
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success', JSON.stringify(result));
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length <= 1500, 'command output stays compact');
  assert.match(result.text, /run-\d{8}-\d{6}-[0-9a-f]{4}/);
  assert.match(result.text, /scan 模式/);
  assert.match(result.text, /blocker 1/);
  assert.match(result.text, /报告已生成/);

  const runId = /run-\d{8}-\d{6}-[0-9a-f]{4}/.exec(result.text)[0];
  for (const artifact of ['scope.json', 'plan.json', 'reviews.json', 'aggregate.json', 'findings.json', 'gate.json', 'report.md', 'report.json']) {
    const file = path.join(cwd, '.review', 'runs', runId, artifact);
    assert.ok((await stat(file)).isFile(), `${artifact} was written by /review`);
  }

  // A second concurrent invocation is rejected while the first is running.
  const [firstAgain, secondAgain] = await Promise.all([
    command.handler({ rawInput: 'scan quick', signal: new AbortController().signal }),
    command.handler({ rawInput: 'scan quick', signal: new AbortController().signal }),
  ]);
  const errors = [firstAgain, secondAgain].filter((entry) => entry && entry.kind === 'error');
  assert.ok(errors.some((entry) => /正在执行/.test(entry.text)), 'concurrent /review is rejected with an explanatory error');
});

test('review_scope output normalizes optional nulls so the harness schema can validate', async (t) => {
  const cwd = await makeWorkspace(t);
  const harness = createHarness({ cwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  const scope = await callTool(harness, 'review_scope', {});
  assertNoError(scope, 'review_scope');
  assert.ok(Array.isArray(scope.files) && scope.files.length > 0);
  // The deterministic scope marks reviewable files with `excludeReason: null`; the tool
  // boundary must normalize it (null would fail the declared output schema).
  for (const file of scope.files) {
    assert.ok(Object.prototype.hasOwnProperty.call(file, 'excludeReason'), 'excludeReason is always present');
    assert.equal(file.excludeReason, '', 'null is normalized to an empty reason');
  }
  assert.equal(JSON.stringify(scope).includes('"excludeReason":null'), false);
});

test('repo parameter resolves a run stored in another workspace (no session cache)', async (t) => {
  const sessionCwd = await makeWorkspace(t);
  const reviewedRepo = await makeWorkspace(t);
  const runId = 'run-20260101-000000-abcd';
  const runDir = path.join(reviewedRepo, '.review', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const repoInfo = { root: reviewedRepo, name: 'reviewed-repo' };
  await writeFile(
    path.join(runDir, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, runId, mode: 'scan', repo: repoInfo, createdAt: '2026-01-01T00:00:00.000Z', config: {} }),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'scope.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      repo: repoInfo,
      mode: 'scan',
      range: { base: null, head: null, mergeBase: null, commit: null },
      files: [
        {
          path: 'src/add.ts',
          status: 'existing',
          binary: false,
          reviewable: true,
          excludeReason: null,
          insertions: 0,
          deletions: 0,
          bytes: ADD_SOURCE.length,
        },
      ],
      counts: { total: 1, reviewable: 1, excluded: 0, insertions: 0, deletions: 0 },
      coverage: { complete: true, unreviewed: [] },
    }),
    'utf8',
  );

  const harness = createHarness({ cwd: sessionCwd });
  plugin.apply(harness.ctx, harness.pluginConfig);

  // No review_scope call for this run: the session workspace cannot resolve it, which is
  // exactly why the `repo` parameter must drive run resolution.
  const missing = await callTool(harness, 'review_plan', { runId, effort: 'quick' });
  assert.ok(missing && missing.error, 'without repo the session workspace cannot resolve the remote run');

  const plan = await callTool(harness, 'review_plan', { repo: reviewedRepo, runId, effort: 'quick' });
  assertNoError(plan, 'review_plan');
  assert.equal(plan.runId, runId);
  assert.ok((await stat(path.join(runDir, 'plan.json'))).isFile(), 'plan.json lands in the reviewed repository run');
});
