/**
 * lib/report.mjs — CONTRACT §7: write `report.md`, `report.json`, `report.sarif`.
 *
 * `writeReports({ runDir, scope, plan, aggregate, gate, meta })`
 *   -> { md, json, sarif }  (absolute paths)
 *
 * report.md  : Chinese human report (结论/阻断项/需人工判断/非阻断/覆盖清单/门禁/成本统计)
 * report.json: full machine-readable data, `schemaVersion: 1`
 * report.sarif: valid SARIF 2.1.0; only anchored findings get physical locations.
 *
 * Secrets are never written: key-like fields/values are stripped defensively.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const TOOL_NAME = 'dsh-code-reviewer';
const TOOL_VERSION = '0.1.0';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const META_SEPARATOR = '\n\n---\n\n生成时间：';

const CATEGORY_TITLES = {
  intent: '意图一致性',
  correctness: '正确性',
  errors: '错误处理',
  concurrency: '并发与异步',
  data: '数据与持久化',
  security: '安全',
  contract: '接口与契约',
  tests: '测试',
  scope: '变更范围',
  history: '历史与经验',
  style: '风格',
  docs: '文档',
  other: '其他',
};

const LEVEL_BY_SEVERITY = { blocker: 'error', major: 'warning', minor: 'note' };
const SEP = '—';

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function oneLine(value, max = 600) {
  const text = toText(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitize(value, depth = 0) {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(key)) {
        continue;
      }
      const cleaned = sanitize(child, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(/\b(sk|ak)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

function escapeCell(value) {
  return toText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function codeSpan(value) {
  const text = toText(value).replace(/`/g, "'");
  return `\`${text}\``;
}

function locationText(finding) {
  if (!finding) return '（未定位）';
  const file = toText(finding.file) || '（未知文件）';
  const start = Number(finding.startLine);
  const end = Number(finding.endLine);
  if (Number.isFinite(start) && start > 0) {
    const line = Number.isFinite(end) && end > start ? `${start}-${end}` : `${start}`;
    return `${file}:${line}`;
  }
  if (Number.isFinite(Number(finding.line)) && Number(finding.line) > 0) {
    return `${file}:?（原始行号 ${finding.line}）`;
  }
  return `${file}（未锚定）`;
}

function severityBadge(finding) {
  return `${finding.severity ?? 'minor'}/${finding.category ?? 'other'}`;
}

function findingBlock(finding, index) {
  const title = oneLine(finding.problem) || '（无标题）';
  const lines = [];
  lines.push(`### ${index}. ${title}`);
  lines.push('');
  lines.push(
    `- 位置：${codeSpan(locationText(finding))} ${SEP} 严重度：**${finding.severity ?? 'minor'}** ${SEP} 类别：${CATEGORY_TITLES[finding.category] ?? finding.category ?? 'other'}`,
  );
  if (finding.status === 'needs-human') lines.push('- 状态：**需人工判断**（证据不足或评审输出不可用）');
  else if (finding.preexisting) lines.push('- 状态：本 diff 之前已存在（preexisting）');
  if (finding.votes !== undefined) {
    const lenses = asArray(finding.lenses).join(', ');
    lines.push(`- 视角票数：${finding.votes}${lenses ? `（${lenses}）` : ''}`);
  }
  if (finding.fingerprint) lines.push(`- fingerprint：${codeSpan(finding.fingerprint)}`);
  if (finding.evidence) lines.push(`- 证据：${oneLine(finding.evidence, 1200)}`);
  if (finding.impact) lines.push(`- 影响：${oneLine(finding.impact, 1200)}`);
  if (finding.suggestion) lines.push(`- 建议：${oneLine(finding.suggestion, 1200)}`);
  if (finding.anchorReason) lines.push(`- 定位说明：${oneLine(finding.anchorReason, 200)}`);
  lines.push('');
  return lines.join('\n');
}

function buildMarkdown({ scope, plan, aggregate, gate, meta, generatedAt, artifacts }) {
  const aggregateData = aggregate && typeof aggregate === 'object' ? aggregate : {};
  const findings = asArray(aggregateData.findings);
  const counts = aggregateData.counts ?? { blocker: 0, major: 0, minor: 0, needsHuman: 0, dropped: 0 };
  const blocking = asArray(aggregateData.blocking);
  const errors = asArray(aggregateData.errors);
  const humanAttention = asArray(aggregateData.humanAttention);
  const metaData = meta && typeof meta === 'object' ? meta : {};
  const gateData = gate && typeof gate === 'object' ? gate : null;
  // The deterministic gate is authoritative for the conclusion: an aggregate "needs-human"
  // caused by reviewer questions must not mark a passing gate as un-passable.
  const gateVerdict = gateData && gateData.verdict;
  const aggregateVerdict = aggregateData.verdict ?? 'pass';
  const verdict = gateVerdict
    ? gateVerdict === 'fail'
      ? 'block'
      : gateVerdict === 'needs-human'
        ? 'needs-human'
        : 'pass'
    : aggregateVerdict;
  const verdictText =
    verdict === 'block' ? '阻断（存在必须修复的问题）' : verdict === 'needs-human' ? '需人工判断' : '通过';

  const md = [];
  md.push('# 代码评审报告');
  md.push('');
  md.push(
    [
      `- runId：${codeSpan(metaData.runId ?? scope?.runId ?? '(unknown)')}`,
      `- 范围模式：${codeSpan(scope?.mode ?? metaData.mode ?? '(unknown)')}`,
      `- 评审强度：${codeSpan(plan?.effort ?? metaData.effort ?? '(unknown)')}`,
      `- 轮次：${metaData.rounds ?? SEP}`,
      `- 生成时间：${generatedAt}`,
      `- 工具：${TOOL_NAME} v${TOOL_VERSION}`,
    ].join('\n'),
  );
  const model = metaData.model;
  if (model && typeof model === 'object') {
    const parts = [model.transport, model.model].filter(Boolean);
    if (model.effort) parts.push(`effort=${model.effort}`);
    if (model.baseUrlHost) parts.push(`endpoint=${model.baseUrlHost}`);
    if (parts.length > 0) md.push(`- 模型：${codeSpan(parts.join(' / '))}`);
  }
  md.push('');

  /* ------------------------------- 结论 ------------------------------- */
  md.push('## 结论');
  md.push('');
  md.push(`**${verdictText}**`);
  md.push('');
  md.push('| blocker | major | minor | 需人工判断 | 已丢弃 |');
  md.push('| --- | --- | --- | --- | --- |');
  md.push(
    `| ${counts.blocker ?? 0} | ${counts.major ?? 0} | ${counts.minor ?? 0} | ${counts.needsHuman ?? 0} | ${counts.dropped ?? 0} |`,
  );
  if (gate && typeof gate === 'object') {
    md.push('');
    md.push(
      `门禁结果：**${gate.verdict ?? 'unknown'}**（exitCode ${gate.exitCode ?? '?'}）；阻断项 ${blocking.length} 条。`,
    );
  } else {
    md.push('');
    md.push('门禁：未运行（本次仅完成评审）。');
  }
  md.push('');

  /* ------------------------------ 阻断项 ------------------------------ */
  md.push('## 阻断项');
  md.push('');
  if (blocking.length === 0) {
    md.push('无阻断项。');
    md.push('');
  } else {
    const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
    blocking.forEach((item, index) => {
      const finding = byFingerprint.get(item.fingerprint) ?? {
        ...item,
        problem: item.title,
        status: 'real',
      };
      md.push(findingBlock(finding, index + 1));
    });
  }

  /* ---------------------------- 需人工判断 ---------------------------- */
  md.push('## 需人工判断');
  md.push('');
  const needsHuman = findings.filter((finding) => finding.status === 'needs-human');
  const unanchored = findings.filter(
    (finding) => finding.status !== 'dropped' && finding.anchored === false,
  );
  const hasHumanSection =
    needsHuman.length > 0 || unanchored.length > 0 || humanAttention.length > 0 || errors.length > 0;
  if (!hasHumanSection) {
    md.push('无需要人工判断的内容。');
    md.push('');
  }
  if (needsHuman.length > 0) {
    md.push('### 证据不足 / 无法自动定位');
    md.push('');
    needsHuman.forEach((finding, index) => {
      md.push(findingBlock(finding, index + 1));
      if (finding.existing_code) {
        md.push('引用的既有代码：');
        md.push('');
        md.push('```');
        md.push(toText(finding.existing_code));
        md.push('```');
        md.push('');
      }
    });
  }
  if (unanchored.length > 0) {
    md.push('### 未能定位到新文件行号（不写入 SARIF）');
    md.push('');
    for (const finding of unanchored) {
      md.push(
        `- ${codeSpan(locationText(finding))} ${SEP} ${severityBadge(finding)} ${SEP} ${oneLine(finding.problem, 300)}（原因：${finding.anchorReason ?? 'unknown'}）`,
      );
    }
    md.push('');
  }
  if (humanAttention.length > 0) {
    md.push('### Reviewer 提出的人工关注点');
    md.push('');
    for (const item of humanAttention) md.push(`- ${oneLine(item, 500)}`);
    md.push('');
  }
  if (errors.length > 0) {
    md.push('### 评审器异常');
    md.push('');
    for (const error of errors) {
      md.push(
        `- ${codeSpan(`${error.unitId ?? '?'}/${error.lens ?? '?'}`)} ${SEP} ${error.code ?? 'ERROR'}：${oneLine(error.message, 400)}`,
      );
    }
    md.push('');
  }

  /* ------------------------------ 非阻断 ------------------------------ */
  md.push('## 非阻断');
  md.push('');
  const nonBlocking = findings.filter(
    (finding) => finding.status === 'real' && finding.blocking !== true,
  );
  if (nonBlocking.length === 0) {
    md.push('无非阻断问题。');
    md.push('');
  } else {
    nonBlocking.forEach((finding, index) => md.push(findingBlock(finding, index + 1)));
  }
  const dropped = findings.filter((finding) => finding.status === 'dropped');
  if (dropped.length > 0) {
    md.push('### 已丢弃（不计入结论）');
    md.push('');
    for (const finding of dropped) {
      md.push(
        `- ${severityBadge(finding)} ${SEP} ${codeSpan(locationText(finding))} ${SEP} ${oneLine(finding.problem, 240)}（原因：${finding.dropReason ?? 'policy'}）`,
      );
    }
    md.push('');
  }

  /* ----------------------------- 覆盖清单 ----------------------------- */
  md.push('## 覆盖清单');
  md.push('');
  const scopeFiles = asArray(scope?.files);
  const scopeCounts = scope?.counts ?? {};
  md.push(
    `共 ${scopeFiles.length} 个变更文件：可评审 ${scopeCounts.reviewable ?? scopeFiles.filter((file) => file?.reviewable).length}，` +
      `排除 ${scopeCounts.excluded ?? scopeFiles.filter((file) => file && file.reviewable === false).length}，` +
      `新增行 ${scopeCounts.insertions ?? '?'}，删除行 ${scopeCounts.deletions ?? '?'}。`,
  );
  const coverage = scope?.coverage;
  if (coverage && typeof coverage === 'object') {
    md.push('');
    md.push(
      coverage.complete === false
        ? `覆盖率：**不完整**，未评审：${asArray(coverage.unreviewed).map((item) => codeSpan(item)).join('、') || '（未列出）'}`
        : '覆盖率：完整',
    );
  }
  md.push('');
  if (scopeFiles.length > 0) {
    md.push('| 文件 | 状态 | +/− | 可评审 | 排除原因 |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const file of scopeFiles) {
      md.push(
        `| ${escapeCell(codeSpan(file?.path ?? '?'))} | ${escapeCell(file?.status ?? '?')} | ${file?.insertions ?? 0}/${file?.deletions ?? 0} | ${file?.reviewable === false ? '否' : '是'} | ${escapeCell(file?.excludeReason ?? '')} |`,
      );
    }
    md.push('');
  }
  const skippedFiles = asArray(plan?.skippedFiles);
  if (skippedFiles.length > 0) {
    md.push('### 计划阶段跳过的文件');
    md.push('');
    for (const skipped of skippedFiles) {
      md.push(`- ${codeSpan(skipped?.path ?? '?')}：${skipped?.reason ?? 'unknown'}`);
    }
    md.push('');
  }
  const units = asArray(plan?.units);
  if (units.length > 0) {
    md.push('### 评审单元');
    md.push('');
    md.push('| unit | 文件数 | 变更行 | 视角 |');
    md.push('| --- | --- | --- | --- |');
    for (const unit of units) {
      md.push(
        `| ${escapeCell(unit?.unitId ?? '?')} | ${asArray(unit?.files).length} | ${unit?.stats?.changedLines ?? '?'} | ${escapeCell(asArray(unit?.lenses).join(', '))} |`,
      );
    }
    md.push('');
  }

  /* ------------------------------- 门禁 ------------------------------- */
  md.push('## 门禁');
  md.push('');
  if (!gate || typeof gate !== 'object') {
    md.push('未运行门禁。');
    md.push('');
  } else {
    md.push(`门禁 verdict：**${gate.verdict ?? 'unknown'}** ${SEP} exitCode：${gate.exitCode ?? '?'}`);
    md.push('');
    const checks = asArray(gate.checks);
    if (checks.length === 0) {
      md.push('未检测/配置任何门禁命令。');
      md.push('');
    } else {
      md.push('| 检查 | 命令 | 退出码 | 耗时 | required | 跳过 |');
      md.push('| --- | --- | --- | --- | --- | --- |');
      for (const check of checks) {
        md.push(
          `| ${escapeCell(check?.id ?? '?')} | ${escapeCell(codeSpan(check?.cmd ?? '?'))} | ${check?.exit ?? '?'} | ${check?.durationMs ?? '?'}ms | ${check?.required === false ? '否' : '是'} | ${check?.skipped ? '是' : '否'} |`,
        );
      }
      md.push('');
      const failed = checks.find((check) => !check?.skipped && check?.required !== false && check?.exit !== 0);
      if (failed && failed.stdoutTail) {
        md.push(`失败命令 \`${toText(failed.cmd)}\` 输出尾部：`);
        md.push('');
        md.push('```text');
        md.push(toText(failed.stdoutTail));
        md.push('```');
        md.push('');
      }
    }
  }

  /* ----------------------------- 成本统计 ----------------------------- */
  md.push('## 成本统计');
  md.push('');
  const usage = metaData.usage ?? aggregateData.usage ?? {};
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  md.push('| 指标 | 数值 |');
  md.push('| --- | --- |');
  md.push(`| LLM 调用次数 | ${number(metaData.calls ?? usage.calls)} |`);
  md.push(`| 输入 tokens | ${number(usage.inputTokens)} |`);
  md.push(`| 输出 tokens | ${number(usage.outputTokens)} |`);
  md.push(`| 缓存读取 tokens | ${number(usage.cacheReadTokens)} |`);
  md.push(`| 缓存写入 tokens | ${number(usage.cacheWriteTokens)} |`);
  md.push(`| 评审耗时 | ${number(metaData.durationMs ?? usage.durationMs)} ms |`);
  if (metaData.startedAt || metaData.finishedAt) {
    md.push(`| 开始/结束 | ${metaData.startedAt ?? '?'} / ${metaData.finishedAt ?? '?'} |`);
  }
  md.push('');

  if (artifacts?.json || artifacts?.sarif) {
    md.push('---');
    md.push('');
    md.push(
      `机器可读产物：${[artifacts.json, artifacts.sarif].filter(Boolean).map((item) => codeSpan(item)).join('、')}`,
    );
    md.push('');
  }
  md.push(META_SEPARATOR.trim());
  md.push(generatedAt);
  md.push('');
  return md.join('\n');
}

function sarifRuleIdFor(category) {
  return `dsh-${category || 'other'}`;
}

function buildSarif({ aggregate, gate, meta, generatedAt }) {
  const aggregateData = aggregate && typeof aggregate === 'object' ? aggregate : {};
  const findings = asArray(aggregateData.findings);
  const anchored = findings.filter(
    (finding) =>
      finding &&
      finding.anchored === true &&
      Number.isFinite(Number(finding.startLine)) &&
      Number(finding.startLine) > 0 &&
      finding.status !== 'dropped',
  );

  const ruleIds = new Map();
  for (const finding of anchored) {
    const category = finding.category ?? 'other';
    if (!ruleIds.has(category)) {
      ruleIds.set(category, {
        id: sarifRuleIdFor(category),
        name: category,
        shortDescription: { text: CATEGORY_TITLES[category] ?? category },
        defaultConfiguration: { level: LEVEL_BY_SEVERITY[finding.severity] ?? 'note' },
      });
    }
  }

  const results = anchored.map((finding) => {
    const severity = finding.severity ?? 'minor';
    const region = { startLine: Number(finding.startLine) };
    const endLine = Number(finding.endLine);
    if (Number.isFinite(endLine) && endLine > region.startLine) region.endLine = endLine;
    const messageParts = [
      oneLine(finding.problem, 2000),
      finding.evidence ? `证据：${oneLine(finding.evidence, 2000)}` : '',
      finding.impact ? `影响：${oneLine(finding.impact, 1000)}` : '',
      finding.suggestion ? `建议：${oneLine(finding.suggestion, 1000)}` : '',
    ].filter(Boolean);
    return {
      ruleId: sarifRuleIdFor(finding.category ?? 'other'),
      level: LEVEL_BY_SEVERITY[severity] ?? 'note',
      message: { text: messageParts.join('\n') || '未命名问题' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toText(finding.file).replace(/\\/g, '/') },
            region,
          },
        },
      ],
      partialFingerprints: { dshFingerprint: toText(finding.fingerprint) },
      properties: {
        severity,
        category: finding.category ?? 'other',
        status: finding.status ?? 'real',
        votes: Number(finding.votes) || 0,
        lenses: asArray(finding.lenses),
        preexisting: finding.preexisting === true,
        blocking: finding.blocking === true,
        fingerprint: toText(finding.fingerprint),
      },
    };
  });

  const metaData = meta && typeof meta === 'object' ? meta : {};
  const exitCode = Number.isFinite(Number(gate?.exitCode)) ? Number(gate.exitCode) : 0;
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: toText(metaData.version) || TOOL_VERSION,
            informationUri: 'https://github.com/local/dsh-code-reviewer',
            rules: [...ruleIds.values()],
          },
        },
        invocations: [
          {
            executionSuccessful: exitCode === 0,
            exitCode,
            startTimeUtc: metaData.startedAt ?? generatedAt,
            endTimeUtc: metaData.finishedAt ?? generatedAt,
            toolExecutionNotifications: asArray(aggregateData.errors).map((error) => ({
              level: 'warning',
              message: {
                text: `${error.code ?? 'ERROR'}: ${oneLine(error.message, 500)}`,
              },
            })),
          },
        ],
        results,
        properties: {
          generatedAt,
          runId: toText(metaData.runId ?? ''),
          verdict: aggregateData.verdict ?? 'pass',
          counts: aggregateData.counts ?? {},
        },
      },
    ],
  };
  return sarif;
}

/* ------------------------------------------------------------------------- */
/* public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {{runDir: string, scope?: object, plan?: object, aggregate?: object,
 *          gate?: object|null, meta?: object}} args
 * @returns {{md: string, json: string, sarif: string}}
 */
export function writeReports({ runDir, scope, plan, aggregate, gate, meta } = {}) {
  if (typeof runDir !== 'string' || runDir.trim() === '') {
    throw makeError('CONFIG', 'writeReports 需要 runDir');
  }
  const directory = isAbsolute(runDir) ? runDir : resolve(runDir);
  mkdirSync(directory, { recursive: true });

  const generatedAt = toText(meta?.generatedAt) || new Date().toISOString();
  const paths = {
    md: join(directory, 'report.md'),
    json: join(directory, 'report.json'),
    sarif: join(directory, 'report.sarif'),
  };

  const safeMeta = sanitize(meta ?? {}) ?? {};
  const safeScope = sanitize(scope ?? null) ?? null;
  const safePlan = sanitize(plan ?? null) ?? null;
  const safeAggregate = sanitize(aggregate ?? {}) ?? {};
  const safeGate = gate ? sanitize(gate) : null;

  const markdown = buildMarkdown({
    scope: safeScope,
    plan: safePlan,
    aggregate: safeAggregate,
    gate: safeGate,
    meta: safeMeta,
    generatedAt,
    artifacts: { json: paths.json, sarif: paths.sarif, md: paths.md },
  });

  const reportJson = {
    schemaVersion: 1,
    runId: safeMeta.runId ?? safeScope?.runId ?? null,
    generatedAt,
    tool: { name: TOOL_NAME, version: toText(safeMeta.version) || TOOL_VERSION },
    mode: safeScope?.mode ?? safeMeta.mode ?? null,
    effort: safePlan?.effort ?? safeMeta.effort ?? null,
    rounds: safeMeta.rounds ?? null,
    model: safeMeta.model ?? null,
    usage: safeMeta.usage ?? safeAggregate.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    calls: safeMeta.calls ?? 0,
    durationMs: safeMeta.durationMs ?? 0,
    startedAt: safeMeta.startedAt ?? null,
    finishedAt: safeMeta.finishedAt ?? null,
    scope: safeScope,
    plan: safePlan,
    aggregate: safeAggregate,
    gate: safeGate,
    meta: safeMeta,
  };

  const sarif = buildSarif({
    aggregate: safeAggregate,
    gate: safeGate,
    meta: safeMeta,
    generatedAt,
  });

  writeFileSync(paths.md, `${markdown}\n`, 'utf8');
  writeFileSync(paths.json, `${JSON.stringify(reportJson, null, 2)}\n`, 'utf8');
  writeFileSync(paths.sarif, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8');

  return { md: paths.md, json: paths.json, sarif: paths.sarif };
}

export default writeReports;
