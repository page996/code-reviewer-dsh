# case: paper-translator（DSH 插件，无 `.git` → scan 模式）

## 仓库

- 路径：`C:\Users\Siyu_Zhu\Documents\deepseek-harness\default-workspace\dsh-paper-translator-v8`
- 形态：DSH Web UI 插件（bundle，`@local/dsh-paper-translator` 1.8.0），Host 半区 `index.js` + `lib/`，Client 半区 `client.js` + `assets/`，Python 抽取/渲染器 `python/`。
- 规模（实测约 100 个文件）：`index.js` 5,045 行；`lib/*.js` 19 个模块约 15.3k 行；`python/*.py` 6 个文件约 13.8k 行；`client.js` 4,871 行；`assets/*.js` 含 3 个大 UI 文件与 vendored KaTeX。
- 测试资产：`tools/test_*.mjs` 13 个测试脚本 + `tools/verify_*.py`；`package.json` **没有** `scripts.lint/typecheck/test`。
- 版本控制：**无 `.git`** —— 必须 `scan`。

## 评审范围与批次

| 批次 | 对象 | 视角/强度 | runId | 结果 |
|---|---|---|---|---|
| batch-1 | `lib/util.js` | quick（intent/correctness） | `run-20261116-190955-746b` | 6 minor，全部 accepted |
| batch-2 | `lib/gateway.js` | standard（intent/correctness/errors/security/contract；scan 模式跳过 tests 视角） | `run-20261116-193909-9bc6` | 首轮 17 minor（13 accepted + 4 判为 unit-scope 测试噪声 rejected），复评后 13/13 accepted 全命中、0 漏报；3 条 major 为新增 |
| batch-3 | `lib/pipeline.js` | standard（同 batch-2 lenses） | `run-20261116-203528-92c0` | 14 minor，全部 accepted；`review eval`：matched 14 / missed 0 / noise 0 / notEvaluated 23 → **pass** |
| batch-4 | `index.js`（Host：工具注册、HTTP API、任务队列） | standard（同 lenses，单文件 ~5k 行） | `run-20261116-204833-fc82` | 19 minor，全部 accepted；`review eval`：matched 19 / missed 0 / noise 0 → **pass** |
| batch-5（待做） | `lib/{library,workspace,graph,notes-store}` | standard | — | — |
| batch-6（待做） | `python/*.py` 与 `client/assets` 跨端契约 | standard | — | — |

排除：`assets/katex/**`（vendored）、`python/__pycache__/**`、`*.pyc`、`locale/*.json`。

## 命令

```powershell
# DSH 插件工具（模型走会话路由 deepseek-flash / reasoningEffort=max，无需 API key）
review_scope  { repo: <paper-translator>, mode: "scan", path: "lib/gateway.js" }
review_plan   { runId: <rid>, repo: <paper-translator>, effort: "standard" }
review_run    { runId: <rid>, repo: <paper-translator>, effort: "standard" }
review_gate   { runId: <rid>, repo: <paper-translator> }
review_report { runId: <rid>, repo: <paper-translator> }

# CLI 等价（需要 DEEPSEEK_API_KEY 环境变量）
node bin/review.mjs scan --path <pt>\lib\gateway.js --effort standard

# 回归
node bin/review.mjs eval --repo <pt> --case cases/paper-translator --run latest
```

## 真实缺陷（batch-1 + batch-2 accepted）

`lib/util.js`：分块超长不切、catch-all 读错误、非原子写、字面路径校验、JSON 起点启发式、mapLimit 空洞数组。
`lib/gateway.js`：readdir 错误吞成空目录、审批 summary.bytes 取自请求体、docId 无界 Map、executors 契约不一致、mint 路径归一化裸错、pending 上限 check-then-act、decide 状态自相矛盾、consume 吞错/不审计/执行前标记 consumed、决定者身份不校验、审批审计可丢、过期语义未测等。

## 本 case 触发的产品改进（已落地）

| 问题 | 修复 |
|---|---|
| 无任务契约时 human_attention 噪声把 verdict 顶成 needs-human | `lib/prompts.mjs` 限 3 条；`lib/aggregate.mjs`/`lib/gate.mjs` 不再让 human_attention 参与 verdict/exit |
| report 结论与 gate 矛盾 | `lib/report.mjs` 结论以 gate.verdict 为准 |
| 插件输出 null 导致 harness schema 校验失败 | `plugins/dsh/index.js` 注册时按输出 schema 清洗 |
| 跨仓库 run 无法解析 | 工具新增 `repo` 参数（plan/run/gate/report/ledger） |
| scan 模式下 tests 视角只报「本单元没测试」 | `lib/plan.mjs`：scan 默认跳过 tests 视角（显式 lenses 可覆盖）；`lib/aggregate.mjs` 兜底 drop `unit-scope-test-gap` |
| case 回归误报：跨文件/跨类别/措辞漂移 | `lib/eval.mjs`：按 scope 过滤 + 同文件近似行/标题相似度 + 类别族约束 |
| 路径/Windows/吞错误/审批元数据规则缺口 | `rules/lang-js-ts.md`、`rules/core-security.md`、`rules/core-concurrency.md` 新增条目 |

## 当前回归状态（诚实记录）

- batch-3：`review eval --run run-20261116-203528-92c0` → **pass**（matched 14 / missed 0 / noise 0 / notEvaluated 23）。
- batch-4：`review eval --run run-20261116-204833-fc82` → **pass**（matched 19 / missed 0 / noise 0 / notEvaluated 37）。
- batch-2：`--run run-20261116-193909-9bc6`（插件仍缓存旧 `lib/plan.mjs`，tests 视角未跳过；本机无重启）→ matched 13 / missed 0 / noise 2–4，exit 2；属运行时缓存而非代码回归。
- 新增 `review.temperature=0` 与 reviewer 传输重试后，**重启 DSH** 重跑 batch-2 预期稳定通过（重复运行结果一致）。
- eval 语义已按 run scope 过滤：其他批次基线在当前 run 中计 `notEvaluated`，不再误判漏报。

## 下一步

1. 重启 DSH 后重跑 batch-2（plan→run），确认 tests 视角消失、eval 转 pass。
2. batch-3/4/5 继续追加基线；误报出现时补 `rejected` 样例。
3. 把新增规则对应到 `review eval` 的稳定性观察（每次追加 run 都跑一次 eval）。
