#!/usr/bin/env node
/**
 * CLI entry — CONTRACT §8.
 *
 * Subcommands: scope | plan | run | gate | report | all | scan | hook |
 *              install-hooks | runs | eval
 *
 * `--json` guarantees exactly one JSON object on stdout; every log line goes to
 * stderr. Exit codes: 0 pass, 2 blocking findings, 3 needs-human, 4 gate failure,
 * 5 engine/config error, 1 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { EFFORTS, LENSES, deepMerge, loadConfig } from '../lib/config.mjs';
import { resolveEnv } from '../lib/dotenv.mjs';
import { SCOPES, createScope } from '../lib/scope.mjs';
import { loadRules } from '../lib/rules.mjs';
import { buildPlan } from '../lib/plan.mjs';
import { createRun, listRuns, readRun, resolveRunDir, writeJson } from '../lib/store.mjs';
import { createLlm } from '../lib/llm.mjs';
import { runReview } from '../lib/review.mjs';
import { anchorFindings } from '../lib/position.mjs';
import { filterFindings } from '../lib/filter.mjs';
import { aggregateFindings } from '../lib/aggregate.mjs';
import { runGate } from '../lib/gate.mjs';
import { writeReports } from '../lib/report.mjs';
import { installHooks, runHook, uninstallHooks } from '../lib/hooks.mjs';
import { evalCase } from '../lib/eval.mjs';

const TOOL_VERSION = '0.1.0';
const REPORT_FORMATS = ['md', 'json', 'sarif'];
const HOOK_NAMES = ['pre-commit', 'pre-push'];

const USAGE = `用法: review <command> [options]

命令:
  scope          选定评审范围（--mode workspace|staged|range|commit|scan）
  plan           为已有 run 生成 plan（--run R [--effort quick|standard|deep]）
  run            LLM 评审已有 plan（--run R [--effort ...] [--lenses a,b] [--rounds N]）
  gate           运行确定性门禁（--run R）
  report         生成报告（--run R [--format md|json|sarif] [--out P]）
  all            scope → plan → run → gate → report
  scan           扫描指定路径：scope(scan) → plan → run → gate → report
  hook           执行 git hook（pre-commit|pre-push）
  install-hooks  安装 .githooks（--uninstall 卸载）
  runs           列出历史 run
  eval           case 回归：对比基线 findings 与 dispositions（--case <dir> [--run latest]）

共同参数:
  --repo D       仓库目录（默认 cwd）
  --config F     配置文件（默认 <repo>/.review/config.json）
  --json         stdout 只输出一个 JSON 对象
  --quiet        减少 stderr 日志

范围参数:
  --mode M --base B --head H --commit C --path P --run-id ID

评审参数:
  --effort quick|standard|deep   --lenses a,b   --rounds N   --contract F
  --no-llm       跳过 LLM 评审（run/all/scan；无需 API key，仅确定性门禁+报告）

退出码: 0 通过 / 2 阻断 / 3 需人工 / 4 门禁失败 / 5 引擎或配置错误 / 1 用法错误`;

class CliError extends Error {
  constructor(message, code = 'USAGE', exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseCli(argv) {
  // Accept both `--flag value` and `--flag=value` (parseArgs handles both).
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      mode: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      commit: { type: 'string' },
      path: { type: 'string' },
      'run-id': { type: 'string' },
      run: { type: 'string' },
      effort: { type: 'string' },
      lenses: { type: 'string' },
      rounds: { type: 'string' },
      contract: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      uninstall: { type: 'boolean', default: false },
      'no-llm': { type: 'boolean', default: false },
      case: { type: 'string' },
    },
  });
  return { values, positionals };
}

function makeLogger(values) {
  const quiet = values.quiet === true;
  return (level, message, extra) => {
    const normalized = String(level || 'info').toLowerCase();
    if (normalized === 'debug' && !process.env.REVIEW_DEBUG) return;
    if (quiet && (normalized === 'debug' || normalized === 'info')) return;
    let line = `[review] ${normalized}: ${message}`;
    if (extra !== undefined) {
      try {
        const text = typeof extra === 'string' ? extra : JSON.stringify(extra);
        if (text) line += ` ${text}`;
      } catch {
        /* ignore unserializable extras */
      }
    }
    process.stderr.write(`${line}\n`);
  };
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function humanLine(values, line) {
  if (values.json) return;
  process.stdout.write(`${line}\n`);
}

function usageError(message) {
  return new CliError(message, 'USAGE', 1);
}

function engineExitCode(error) {
  if (error instanceof CliError) return error.exitCode;
  if (error?.exitCode === 5 || error?.code === 'USAGE') return error?.code === 'USAGE' ? 1 : 5;
  return 5;
}

function errorCode(error) {
  return error instanceof CliError ? error.code : error?.code || 'ENGINE';
}

function wantsJson(argv) {
  return argv.some((arg) => arg === '--json' || arg.startsWith('--json='));
}

function emitErrorJson(error) {
  emitJson({
    schemaVersion: 1,
    ok: false,
    error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) },
    exitCode: engineExitCode(error),
  });
}

function resolveRepo(values) {
  const repo = path.resolve(values.repo || process.cwd());
  let stat = null;
  try {
    stat = fs.statSync(repo);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw usageError(`--repo 不是目录: ${repo}`);
  return repo;
}

function parsePositiveInt(raw, flag) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw).trim())) throw usageError(`${flag} 需要正整数，收到 ${raw}`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) throw usageError(`${flag} 需要正整数，收到 ${raw}`);
  return value;
}

function parseLenses(raw) {
  if (raw === undefined) return undefined;
  const lenses = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (lenses.length === 0) throw usageError('--lenses 不能为空');
  for (const lens of lenses) {
    if (!LENSES.includes(lens)) throw usageError(`--lenses 含未知视角: ${lens}（可选 ${LENSES.join('|')}）`);
  }
  return lenses;
}

function validateEffort(raw) {
  if (raw === undefined) return undefined;
  if (!EFFORTS.includes(raw)) throw usageError(`--effort 只能是 ${EFFORTS.join('|')}，收到 ${raw}`);
  return raw;
}

function validateReportFormat(raw) {
  if (raw === undefined) return undefined;
  if (!REPORT_FORMATS.includes(raw)) throw usageError(`--format 只能是 ${REPORT_FORMATS.join('|')}，收到 ${raw}`);
  return raw;
}

function buildOverrides(values) {
  const overrides = {};
  const effort = validateEffort(values.effort);
  const lenses = parseLenses(values.lenses);
  const rounds = parsePositiveInt(values.rounds, '--rounds');
  const review = {};
  if (effort) review.effort = effort;
  if (lenses) review.lenses = lenses;
  if (rounds) review.rounds = rounds;
  if (values.contract !== undefined) review.contractFile = values.contract;
  if (Object.keys(review).length > 0) overrides.review = review;
  return overrides;
}

function loadCliConfig(values, repo, log) {
  return loadConfig({
    cwd: repo,
    configPath: values.config,
    overrides: buildOverrides(values),
    log,
  });
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

/** Persist the aggregated findings under both the contract name and findings.json. */
function writeAggregateArtifacts(runDir, runId, aggregate) {
  writeJson(runDir, 'aggregate.json', aggregate);
  const findingsRecord = {
    schemaVersion: 1,
    runId,
    verdict: aggregate.verdict ?? 'pass',
    counts: aggregate.counts ?? { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 },
    findings: aggregate.findings ?? [],
    blocking: aggregate.blocking ?? [],
    humanAttention: aggregate.humanAttention ?? [],
    errors: aggregate.errors ?? [],
    stats: aggregate.stats ?? null,
  };
  writeJson(runDir, 'findings.json', findingsRecord);
  return findingsRecord;
}

function ensureApiKey({ config, repo, log }) {
  const env = resolveEnv({ cwd: repo, env: process.env });
  const name = config?.model?.apiKeyEnv || 'DEEPSEEK_API_KEY';
  const value = env?.[name];
  if (typeof value !== 'string' || !value.trim()) {
    log('error', `缺少 API key：请设置环境变量 ${name} 或在 ${path.join(repo, '.env')} / $DSH_HOME/.env 中配置`);
    const err = new Error(`缺少 API key：请设置环境变量 ${name}（或在 .env / $DSH_HOME/.env 中配置）`);
    err.code = 'CONFIG';
    throw err;
  }
  return env;
}

function createLoggerRunners({ config, repo, log }) {
  const env = resolveEnv({ cwd: repo, env: process.env });
  const llm = createLlm({ model: config.model, cwd: repo, env });
  return { llm, env };
}

function safeAnchor(findings, unit) {
  try {
    const anchored = anchorFindings(findings, unit);
    if (Array.isArray(anchored)) return anchored;
    if (anchored && Array.isArray(anchored.findings)) return anchored.findings;
    return findings;
  } catch {
    return findings;
  }
}

/**
 * position -> filter -> aggregate for one completed review result.
 * Filtering is skipped when disabled or when no llm is available.
 */
async function finalizeReview({ reviews, plan, config, llm, log }) {
  const reviewList = Array.isArray(reviews) ? reviews : [];
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const anchored = [];
  let filterUsage = null;
  const filterEnabled = config?.review?.filter !== false && Boolean(llm);
  for (const unit of units) {
    const raw = reviewList
      .filter((review) => review && review.unitId === unit.unitId && !review.error)
      .flatMap((review) =>
        (Array.isArray(review.findings) ? review.findings : []).map((finding) => ({
          ...finding,
          lens: review.lens,
          unitId: unit.unitId,
        })),
      );
    if (raw.length === 0) continue;
    const anchoredUnit = safeAnchor(raw, unit);
    let kept = anchoredUnit;
    if (filterEnabled) {
      try {
        const result = await filterFindings({ unit, findings: anchoredUnit, llm, config });
        if (result && Array.isArray(result.findings)) kept = result.findings;
        if (result?.usage) filterUsage = mergeUsage(filterUsage, result.usage);
      } catch (err) {
        log('warn', `过滤 pass 失败，保留全部发现: ${err.message}`);
        kept = anchoredUnit;
      }
    }
    for (const finding of kept) {
      anchored.push({ ...finding, lens: finding.lens ?? undefined, unitId: finding.unitId ?? unit.unitId });
    }
  }
  const aggregate = aggregateFindings({ reviews: reviewList, anchored, config });
  return { aggregate, filterUsage };
}

function mergeUsage(base, extra) {
  const out = { ...(base || {}) };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    out[key] = (Number(out[key]) || 0) + (Number(extra?.[key]) || 0);
  }
  return out;
}

function runMeta({ run, review, aggregate, llm, extra }) {
  const storedModel = run?.meta?.config?.model;
  let model = null;
  try {
    model = llm?.describe?.() ?? null;
  } catch {
    model = null;
  }
  if (!model && storedModel) model = { transport: storedModel.transport, model: storedModel.model };
  return {
    runId: run?.runId ?? null,
    generatedAt: new Date().toISOString(),
    usage: review?.usage ?? aggregate?.usage ?? null,
    calls: review?.calls ?? null,
    durationMs: review?.durationMs ?? null,
    startedAt: review?.startedAt ?? null,
    finishedAt: review?.finishedAt ?? null,
    model,
    version: TOOL_VERSION,
    ...extra,
  };
}

function printGateHuman(values, gate, aggregate) {
  humanLine(values, `verdict: ${gate.verdict} (exit ${gate.exitCode})`);
  if (aggregate?.counts) {
    const c = aggregate.counts;
    humanLine(values, `findings: blocker=${c.blocker} major=${c.major} minor=${c.minor} needs-human=${c.needsHuman} dropped=${c.dropped}`);
  }
  for (const check of gate.checks || []) {
    humanLine(values, `check ${check.id}: exit=${check.exit}${check.skipped ? ' (skipped)' : ''} ${check.cmd || ''}`);
  }
}

function planFromRun({ run, repo, config, values, log }) {
  const scope = run.scope;
  if (!scope) throw usageError(`run ${run.runId} 缺少 scope.json，请先执行 review scope`);
  const rules = Array.isArray(run.rules?.rules) ? run.rules.rules : loadRules({ cwd: repo, config, log });
  const plan = buildPlan({
    scope,
    config,
    effort: values.effort ?? config.review.effort,
    lenses: parseLenses(values.lenses),
    rules,
    log,
  });
  writeJson(run.runDir, 'plan.json', plan);
  writeJson(run.runDir, 'rules.json', { schemaVersion: 1, runId: run.runId, rules });
  return plan;
}

function configSnapshotForRun({ run, repo, values, log }) {
  const fresh = loadConfig({
    cwd: repo,
    configPath: values.config,
    overrides: buildOverrides(values),
    log,
  });
  const stored = run?.meta?.config;
  if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) {
    // A run is a reproducible snapshot: stored settings win over later repo edits.
    return deepMerge(fresh, stored);
  }
  return fresh;
}

function artifactPaths(runDir) {
  const at = (name) => path.join(runDir, name);
  const candidates = {
    runDir,
    scope: at('scope.json'),
    rules: at('rules.json'),
    plan: at('plan.json'),
    reviews: at('reviews.json'),
    aggregate: at('aggregate.json'),
    findings: at('findings.json'),
    gate: at('gate.json'),
    reportMd: at('report.md'),
    reportJson: at('report.json'),
    reportSarif: at('report.sarif'),
  };
  return candidates;
}

function existingArtifacts(runDir) {
  const artifacts = {};
  for (const [key, file] of Object.entries(artifactPaths(runDir))) {
    if (key === 'runDir') continue;
    try {
      if (fs.statSync(file).isFile()) artifacts[key] = file;
    } catch {
      /* absent */
    }
  }
  return artifacts;
}

async function cmdScope({ values, repo, log }) {
  const config = loadCliConfig(values, repo, log);
  if (values.mode !== undefined && !SCOPES.includes(values.mode)) {
    throw usageError(`--mode 只能是 ${SCOPES.join('|')}，收到 ${values.mode}`);
  }
  const scope = createScope({
    cwd: repo,
    config,
    mode: values.mode || 'workspace',
    base: values.base,
    head: values.head,
    commit: values.commit,
    path: values.path,
    runId: values['run-id'],
    log,
  });
  const { runId, runDir } = createRun({ cwd: repo, config, mode: scope.mode, scope });
  writeJson(runDir, 'scope.json', scope);
  log('info', `scope 完成：${scope.counts.reviewable}/${scope.counts.total} 个文件可评审，runId=${runId}`);
  humanLine(values, `runId: ${runId}`);
  humanLine(values, `mode: ${scope.mode}  reviewable: ${scope.counts.reviewable}/${scope.counts.total}  +${scope.counts.insertions}/-${scope.counts.deletions}`);
  humanLine(values, `runDir: ${runDir}`);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'scope',
      ok: true,
      runId,
      runDir,
      mode: scope.mode,
      range: scope.range,
      counts: scope.counts,
      coverage: scope.coverage,
      files: scope.files,
      artifacts: { scope: artifactPaths(runDir).scope },
      exitCode: 0,
    });
  }
  return 0;
}

async function cmdPlan({ values, repo, log }) {
  if (!values.run) throw usageError('plan 需要 --run R');
  const config = loadCliConfig(values, repo, log);
  const runDir = resolveRunDir(repo, config, values.run);
  const run = readRun(runDir);
  const runConfig = configSnapshotForRun({ run, repo, values, log });
  const plan = planFromRun({ run, repo, config: runConfig, values, log });
  const units = plan.units.length;
  const files = plan.units.reduce((sum, unit) => sum + unit.files.length, 0);
  log('info', `plan 完成：${units} 个 unit，${files} 个文件`);
  humanLine(values, `runId: ${run.runId}  units: ${units}  files: ${files}  effort: ${plan.effort}`);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'plan',
      ok: true,
      runId: run.runId,
      runDir,
      effort: plan.effort,
      lenses: plan.lenses,
      units: units,
      files,
      skippedFiles: plan.skippedFiles.length,
      artifacts: { plan: artifactPaths(runDir).plan, rules: artifactPaths(runDir).rules },
      exitCode: 0,
    });
  }
  return 0;
}

async function cmdRun({ values, repo, log }) {
  if (!values.run) throw usageError('run 需要 --run R');
  const baseConfig = loadCliConfig(values, repo, log);
  const runDir = resolveRunDir(repo, baseConfig, values.run);
  const run = readRun(runDir);
  if (!run.scope) throw usageError(`run ${run.runId} 缺少 scope.json，请先执行 review scope`);
  const config = configSnapshotForRun({ run, repo, values, log });
  let plan = run.plan;
  if (!plan || values.effort !== undefined || values.lenses !== undefined) {
    plan = planFromRun({ run, repo, config, values, log });
  }
  if (values['no-llm']) {
    const aggregate = emptyAggregate();
    writeAggregateArtifacts(runDir, run.runId, aggregate);
    log('info', 'run --no-llm：跳过 LLM 评审，写入空 findings');
    humanLine(values, `runId: ${run.runId}  verdict: ${aggregate.verdict}  findings: 0 (no-llm)`);
    if (values.json) {
      emitJson({
        schemaVersion: 1,
        command: 'run',
        ok: true,
        runId: run.runId,
        runDir,
        effort: plan.effort,
        llm: false,
        rounds: 0,
        counts: aggregate.counts,
        verdict: aggregate.verdict,
        usage: null,
        artifacts: { aggregate: artifactPaths(runDir).aggregate, findings: artifactPaths(runDir).findings },
        exitCode: 0,
      });
    }
    return 0;
  }
  const env = ensureApiKey({ config, repo, log });
  const llm = createLlm({ model: config.model, cwd: repo, env });
  const startedAt = new Date().toISOString();
  const review = await runReview({ scope: run.scope, plan, config, llm, cwd: repo, log });
  const finishedAt = new Date().toISOString();
  const reviewRecord = {
    schemaVersion: 1,
    runId: run.runId,
    rounds: review.rounds ?? config.review.rounds,
    reviews: review.reviews ?? [],
    usage: review.usage ?? null,
    calls: review.calls ?? null,
    durationMs: review.durationMs ?? null,
    startedAt: review.startedAt ?? startedAt,
    finishedAt: review.finishedAt ?? finishedAt,
  };
  writeJson(runDir, 'reviews.json', reviewRecord);
  const { aggregate, filterUsage } = await finalizeReview({
    reviews: reviewRecord.reviews,
    plan,
    config,
    llm,
    log,
  });
  writeAggregateArtifacts(runDir, run.runId, aggregate);
  const usage = filterUsage ? mergeUsage(reviewRecord.usage, filterUsage) : reviewRecord.usage;
  const rounds = reviewRecord.rounds;
  log('info', `run 完成：verdict=${aggregate.verdict} findings=${aggregate.findings.length}`);
  humanLine(values, `runId: ${run.runId}  verdict: ${aggregate.verdict}  findings: ${aggregate.findings.length}`);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'run',
      ok: true,
      runId: run.runId,
      runDir,
      effort: plan.effort,
      llm: true,
      rounds,
      counts: aggregate.counts,
      verdict: aggregate.verdict,
      usage,
      artifacts: {
        reviews: artifactPaths(runDir).reviews,
        aggregate: artifactPaths(runDir).aggregate,
        findings: artifactPaths(runDir).findings,
      },
      exitCode: 0,
    });
  }
  return 0;
}

async function cmdGate({ values, repo, log }) {
  if (!values.run) throw usageError('gate 需要 --run R');
  const config = loadCliConfig(values, repo, log);
  const runDir = resolveRunDir(repo, config, values.run);
  const run = readRun(runDir);
  const aggregate = run.aggregate ?? emptyAggregate();
  const gate = await runGate({ cwd: repo, config, aggregate, runDir, log });
  printGateHuman(values, gate, aggregate);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'gate',
      ok: gate.verdict !== 'error',
      runId: run.runId,
      runDir,
      verdict: gate.verdict,
      blocking: gate.blocking ?? [],
      checks: gate.checks ?? [],
      counts: aggregate.counts ?? null,
      artifacts: { gate: artifactPaths(runDir).gate },
      exitCode: gate.exitCode,
    });
  }
  return gate.exitCode;
}

async function cmdReport({ values, repo, log }) {
  if (!values.run) throw usageError('report 需要 --run R');
  const format = validateReportFormat(values.format);
  const config = loadCliConfig(values, repo, log);
  const runDir = resolveRunDir(repo, config, values.run);
  const run = readRun(runDir);
  const aggregate = run.aggregate ?? emptyAggregate();
  const gate = run.gate ?? { schemaVersion: 1, checks: [], verdict: 'pass', blocking: [], exitCode: 0 };
  const reviewRecord = run.reviews ?? null;
  const meta = runMeta({ run, review: reviewRecord, aggregate, llm: null, extra: { effort: run.plan?.effort ?? null, rounds: reviewRecord?.rounds ?? null } });
  const reports = writeReports({ runDir, scope: run.scope, plan: run.plan, aggregate, gate, meta });
  let selected = null;
  let outFile = null;
  if (format) {
    selected = reports[format];
    if (values.out) {
      outFile = path.resolve(repo, values.out);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.copyFileSync(selected, outFile);
    } else if (!values.json) {
      process.stdout.write(fs.readFileSync(selected, 'utf8'));
      selected = null;
    }
  }
  log('info', `report 完成：${reports.md}`);
  if (!values.json) {
    humanLine(values, `runId: ${run.runId}`);
    humanLine(values, `report: ${reports.md}`);
    humanLine(values, `json:   ${reports.json}`);
    humanLine(values, `sarif:  ${reports.sarif}`);
    if (outFile) humanLine(values, `copied: ${outFile}`);
  }
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'report',
      ok: true,
      runId: run.runId,
      runDir,
      verdict: gate.verdict ?? null,
      reports,
      selected: selected ?? null,
      out: outFile,
      counts: aggregate.counts ?? null,
      exitCode: 0,
    });
  }
  return 0;
}

async function runPipeline({ values, repo, log, mode, pathValue }) {
  const noLlm = values['no-llm'] === true;
  const config = loadCliConfig(values, repo, log);
  const env = noLlm ? null : ensureApiKey({ config, repo, log });
  const scope = createScope({
    cwd: repo,
    config,
    mode,
    base: values.base,
    head: values.head,
    commit: values.commit,
    path: pathValue,
    runId: values['run-id'],
    log,
  });
  const { runId, runDir, meta: runMetaRecord } = createRun({ cwd: repo, config, mode: scope.mode, scope });
  writeJson(runDir, 'scope.json', scope);
  log('info', `scope: ${scope.counts.reviewable}/${scope.counts.total} 文件，runId=${runId}`);
  const rules = loadRules({ cwd: repo, config, log });
  writeJson(runDir, 'rules.json', { schemaVersion: 1, runId, rules });
  const plan = buildPlan({ scope, config, effort: values.effort, rules, log });
  writeJson(runDir, 'plan.json', plan);
  log('info', `plan: ${plan.units.length} 个 unit`);

  let reviewRecord = null;
  let aggregate;
  let usage = null;
  let llm = null;

  if (noLlm) {
    aggregate = emptyAggregate();
    writeAggregateArtifacts(runDir, runId, aggregate);
    log('info', '--no-llm：跳过 LLM 评审，仅执行确定性门禁/报告');
  } else {
    llm = createLlm({ model: config.model, cwd: repo, env });
    const review = await runReview({ scope, plan, config, llm, cwd: repo, log });
    reviewRecord = {
      schemaVersion: 1,
      runId,
      rounds: review.rounds ?? config.review.rounds,
      reviews: review.reviews ?? [],
      usage: review.usage ?? null,
      calls: review.calls ?? null,
      durationMs: review.durationMs ?? null,
      startedAt: review.startedAt ?? null,
      finishedAt: review.finishedAt ?? null,
    };
    writeJson(runDir, 'reviews.json', reviewRecord);
    const finalized = await finalizeReview({ reviews: reviewRecord.reviews, plan, config, llm, log });
    aggregate = finalized.aggregate;
    usage = finalized.filterUsage ? mergeUsage(reviewRecord.usage, finalized.filterUsage) : reviewRecord.usage;
    writeAggregateArtifacts(runDir, runId, aggregate);
  }

  const gate = await runGate({ cwd: repo, config, aggregate, runDir, log });
  const meta = runMeta({
    run: { runId, meta: runMetaRecord },
    review: reviewRecord ? { ...reviewRecord, usage } : null,
    aggregate,
    llm,
    extra: { effort: plan.effort, rounds: reviewRecord?.rounds ?? 0, llm: !noLlm },
  });
  const reports = writeReports({ runDir, scope, plan, aggregate, gate, meta });
  log('info', `pipeline 完成：gate=${gate.verdict} exit=${gate.exitCode}`);
  printGateHuman(values, gate, aggregate);
  humanLine(values, `runId: ${runId}  effort: ${plan.effort}  units: ${plan.units.length}${noLlm ? '  (no-llm)' : ''}`);
  humanLine(values, `report: ${reports.md}`);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: mode === 'scan' ? 'scan' : 'all',
      ok: gate.verdict !== 'error',
      runId,
      runDir,
      mode,
      effort: plan.effort,
      llm: !noLlm,
      rounds: reviewRecord?.rounds ?? 0,
      counts: { scope: scope.counts, findings: aggregate.counts },
      verdict: gate.verdict,
      blocking: gate.blocking ?? [],
      usage,
      calls: reviewRecord?.calls ?? 0,
      durationMs: reviewRecord?.durationMs ?? null,
      artifacts: {
        scope: artifactPaths(runDir).scope,
        rules: artifactPaths(runDir).rules,
        plan: artifactPaths(runDir).plan,
        reviews: artifactPaths(runDir).reviews,
        aggregate: artifactPaths(runDir).aggregate,
        findings: artifactPaths(runDir).findings,
        gate: artifactPaths(runDir).gate,
        reportMd: reports.md,
        reportJson: reports.json,
        reportSarif: reports.sarif,
      },
      exitCode: gate.exitCode,
    });
  }
  return gate.exitCode;
}

async function cmdAll({ values, repo, log }) {
  if (values.mode !== undefined && !SCOPES.includes(values.mode)) {
    throw usageError(`--mode 只能是 ${SCOPES.join('|')}，收到 ${values.mode}`);
  }
  const mode = values.mode || 'workspace';
  return runPipeline({ values, repo, log, mode, pathValue: values.path });
}

async function cmdScan({ values, repo, log }) {
  const scanPath = values.path || '.';
  return runPipeline({ values, repo, log, mode: 'scan', pathValue: scanPath });
}

async function cmdHook({ values, positionals, repo, log }) {
  const name = positionals[0];
  if (!name) throw usageError(`hook 需要名称: ${HOOK_NAMES.join('|')}`);
  if (!HOOK_NAMES.includes(name)) throw usageError(`未知 hook: ${name}（可选 ${HOOK_NAMES.join('|')}）`);
  const config = loadCliConfig(values, repo, log);
  const result = await runHook({ name, cwd: repo, config, log });
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'hook',
      ok: result.exitCode === 0,
      hook: name,
      skipped: result.skipped === true,
      verdict: result.gate?.verdict ?? null,
      exitCode: result.exitCode ?? 0,
    });
  }
  return typeof result.exitCode === 'number' ? result.exitCode : 0;
}

async function cmdInstallHooks({ values, repo, log }) {
  const result = values.uninstall ? uninstallHooks({ cwd: repo, log }) : installHooks({ cwd: repo, log });
  log('info', values.uninstall ? '已卸载 git hooks' : '已安装 git hooks');
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: values.uninstall ? 'uninstall-hooks' : 'install-hooks',
      ok: true,
      ...result,
      exitCode: 0,
    });
  } else {
    humanLine(values, JSON.stringify(result));
  }
  return 0;
}

async function cmdRuns({ values, repo, log }) {
  const config = loadCliConfig(values, repo, log);
  const runs = listRuns(repo, config);
  log('debug', `runs: ${runs.length}`);
  if (values.json) {
    emitJson({
      schemaVersion: 1,
      command: 'runs',
      ok: true,
      count: runs.length,
      runs: runs.map((run) => ({ runId: run.runId, runDir: run.runDir, createdAt: run.createdAt, mode: run.mode })),
      exitCode: 0,
    });
    return 0;
  }
  if (runs.length === 0) {
    humanLine(values, '暂无 run');
    return 0;
  }
  for (const run of runs) {
    humanLine(values, `${run.createdAt || '-'}  ${run.runId}  ${run.mode || '-'}  ${run.runDir}`);
  }
  return 0;
}

async function cmdEval({ values, repo, log }) {
  if (!values.case) throw usageError('eval 需要 --case <case 目录>');
  const config = loadCliConfig(values, repo, log);
  const runDir = values.run ? resolveRunDir(repo, config, values.run) : undefined;
  const result = evalCase({ caseDir: values.case, cwd: repo, config, runDir, log });
  if (values.json) {
    emitJson({ schemaVersion: 1, command: 'eval', ok: true, ...result, exitCode: result.exitCode });
    return result.exitCode;
  }
  humanLine(values, `case ${result.caseId}: ${result.verdict} (exit ${result.exitCode})`);
  humanLine(
    values,
    `基线 ${result.baseline.total} 条 · 命中 ${result.counts.matched} · 漏报 ${result.counts.missed} · ` +
      `已修复但仍报 ${result.counts.stale} · 已知噪音复现 ${result.counts.noiseStillReported} · 新增 ${result.counts.newFindings}`,
  );
  for (const [label, list] of [
    ['漏报（accepted 未复现）', result.missed],
    ['已修复仍被报出', result.stale],
    ['已知噪音复现', result.noiseStillReported],
  ]) {
    if (list.length === 0) continue;
    humanLine(values, `${label}:`);
    for (const item of list.slice(0, 20)) {
      humanLine(values, `  - ${item.file}:${item.startLine ?? '?'} [${item.category ?? '-'}] ${item.title}`);
    }
  }
  return result.exitCode;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    const failure = new CliError(err instanceof Error ? err.message : String(err), 'USAGE', 1);
    process.stderr.write(`${failure.message}\n\n${USAGE}\n`);
    if (wantsJson(argv)) emitErrorJson(failure);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    if (values.json) emitErrorJson(new CliError('缺少子命令', 'USAGE', 1));
    return 1;
  }
  const log = makeLogger(values);
  try {
    const repo = resolveRepo(values);
    switch (command) {
      case 'scope':
        return await cmdScope({ values, repo, log });
      case 'plan':
        return await cmdPlan({ values, repo, log });
      case 'run':
        return await cmdRun({ values, repo, log });
      case 'gate':
        return await cmdGate({ values, repo, log });
      case 'report':
        return await cmdReport({ values, repo, log });
      case 'all':
        return await cmdAll({ values, repo, log });
      case 'scan':
        return await cmdScan({ values, repo, log });
      case 'hook':
        return await cmdHook({ values, positionals: positionals.slice(1), repo, log });
      case 'install-hooks':
        return await cmdInstallHooks({ values, repo, log });
      case 'runs':
        return await cmdRuns({ values, repo, log });
      case 'eval':
        return await cmdEval({ values, repo, log });
      default:
        throw usageError(`未知子命令: ${command}\n\n${USAGE}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[review] error: ${message}\n`);
    if (values.json) emitErrorJson(err instanceof Error ? err : new CliError(message));
    return engineExitCode(err);
  }
}

const argv = process.argv.slice(2);
const exitCode = await main(argv);
process.exitCode = exitCode;
