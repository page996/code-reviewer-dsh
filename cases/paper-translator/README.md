# case: paper-translator（DSH 插件，无 `.git` → scan 模式）

## 仓库

- 路径：`C:\Users\Siyu_Zhu\Documents\deepseek-harness\default-workspace\dsh-paper-translator-v8`
- 形态：DSH Web UI 插件（bundle，`@local/dsh-paper-translator` 1.8.0），Host 半区 `index.js` + `lib/`，Client 半区 `client.js` + `assets/`，Python 抽取/渲染器 `python/`。
- 规模（实测约 100 个文件，含 3 个 `__pycache__` `.pyc`）：`index.js` 5,045 行；`lib/*.js` 19 个模块约 15.3k 行；`python/*.py` 6 个文件约 13.8k 行；`client.js` 4,871 行；`assets/*.js` 含 3 个大 UI 文件（workbench 6,108 行、graph-view 3,848 行、doc-reader 2,184 行）与 vendored KaTeX。
- 测试资产：`tools/test_*.mjs` 13 个测试脚本 + `tools/verify_*.py`；`package.json` **没有** `scripts.lint/typecheck/test`。
- 版本控制：**无 `.git`** —— 不能用 `range/commit/staged/workspace`，必须 `scan`。

## 评审范围

批次 1（已完成，2026-11-16）：`lib/util.js`（工具函数：分块、JSON 读写、路径边界、并发 mapLimit、超时、模型文本解析）。
批次 2（待做）：`lib/{pipeline,gateway,library,workspace,graph,notes-store,skills}`。
批次 3（待做）：`index.js`（Host：工具注册、HTTP API、任务队列、job 生命周期）。
批次 4（待做）：`python/**/*.py` 与 `client.js`/`assets/*` 的跨端契约。

排除（工具默认 + 项目约定）：`assets/katex/**`（vendored）、`python/__pycache__/**`、`*.pyc`、`locale/*.json`、空 `.git` 目录。

## 命令（批次 1 实际执行）

```powershell
# 1) 用 DSH 插件工具（在 DSH 会话中，模型走会话路由 deepseek-flash / reasoningEffort=max）
review_scope  { repo: <paper-translator 路径>, mode: "scan", path: "lib/util.js" }
review_plan   { runId: <rid>, effort: "quick" }
review_run    { runId: <rid>, effort: "quick" }
review_gate   { runId: <rid> }      # 或 CLI: node bin/review.mjs gate --repo <pt> --run <rid>
review_report { runId: <rid> }

# 2) CLI 等价（需要 DEEPSEEK_API_KEY；本机无 key，故批次 1 用 DSH 插件工具跑模型）
node bin/review.mjs scan --path <pt>\lib\util.js --effort quick
```

- `scan` 模式下 finding 都带 `preexisting=true`；默认 `gate.blockPreexisting=false` 时**不阻塞**，因此本 case 以 `findings.json` + `dispositions.json` 为准。
- 该仓库没有 npm scripts，`gate.autodetect` 探测不到 lint/typecheck/test → 门禁只做 verdict 判定；不影响评审结论。

## 已完成的批次 1 结果

| 项 | 值 |
|---|---|
| runId | `run-20261116-190955-746b` |
| 范围 | `scan`，1 文件 `lib/util.js`（1 unit） |
| 模型 | DSH 会话路由 `deepseek-flash`（V4.1 Flash），`reasoningEffort=max` |
| 强度 | `quick`（intent + correctness 视角，2 次模型调用） |
| findings | blocker 0 / major 0 / minor 6 / needs-human 0 / dropped 0 |
| 门禁 | `pass`（exitCode 0；无 gate.commands） |
| 人工关注点 | 11 条（已判定为噪声：无任务契约导致，非 finding；产品侧已限流到 ≤3 且不再影响 verdict） |
| dispositions | 6 条全部 `accepted`（逐条理由见 `dispositions.json`） |

真实缺陷（均 anchored 到 `lib/util.js` 具体行）：

1. `splitIntoChunks` 只按行切分，单行超长时块可远超 `maxChars`（长中文段落会触发）。
2. `readJson` 无条件 `catch {}` 把 EACCES/EBUSY/解析失败一律当“文件缺失”。
3. `writeJson` 就地覆盖 + catch-all 读回：崩溃/并发时截断 JSON 被当成“无 checkpoint”，静默丢进度。
4. `ensureInside` 只做字面路径比较，未解析 symlink；根内指向外部的链接可通过校验。
5. `jsonFromModel` 取第一个 `[`/`{` 当 JSON 起点，正文先出现括号时解析失败。
6. `mapLimit(limit<=0)` 不报错、返回空洞数组，operation 一次都不执行。

## 本 case 触发的产品改进（已落地）

| 问题 | 修复 |
|---|---|
| 无任务契约时 reviewer 输出 11 条 human_attention，把 verdict 硬顶成 needs-human（exit 3），CI 会假红 | `lib/prompts.mjs`：human_attention ≤3 且只保留影响合并/发布的问题；`lib/aggregate.mjs`：human_attention 不再参与 verdict；`lib/gate.mjs`：只按 needs-human finding / reviewer 错误决定 exit 3 |
| report 结论用 aggregate.verdict，与 gate 结论矛盾（“需人工判断”vs 门禁 pass） | `lib/report.mjs`：结论以 gate.verdict 为准；模型行只显示已知字段 |
| 插件工具输出把 null 当字符串，harness 校验失败（`excludeReason`/`gateVerdict`） | `plugins/dsh/index.js`：注册时按输出 schema 清洗（必填 null→零值，可选 null 丢弃） |
| 路径/Windows/吞错误类规则缺口 | `rules/lang-js-ts.md` 新增「文件与路径（Node/Windows 高频真实缺陷）」4 条 |

## 下一步

1. 批次 2/3/4 继续用同一 case 目录沉淀：每批产出 `run-*/aggregate.json` → 追加到 `findings.json` 基线，补 dispositions。
2. 用 `node bin/review.mjs eval --case cases/paper-translator --run latest` 做回归：`accepted` 必须仍报出，后续判为 `rejected` 的不得复现。
3. 补一条 `rejected` 样例（真实误报出现后填入），并据此调整规则/prompt。
