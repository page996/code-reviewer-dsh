# case: paper-translator（DSH 插件，无 `.git` → scan 模式）

## 仓库

- 路径：DSH 默认工作区 `default-workspace/dsh-paper-translator-v8`（`@local/dsh-paper-translator` 1.8.0；本机绝对路径含用户名，不写入公开文档——复跑 `eval` 时替换为你本地的实际 checkout 路径）。
- 形态：DSH Web UI 插件（bundle，`@local/dsh-paper-translator` 1.8.0），Host 半区 `index.js` + `lib/`，Client 半区 `client.js` + `assets/`，Python 抽取/渲染器 `python/`。
- 规模（实测约 100 个文件）：`index.js` 5,045 行；`lib/*.js` 19 个模块约 15.3k 行；`python/*.py` 6 个文件约 13.8k 行；`client.js` 4,871 行；`assets/*.js` 含 3 个大 UI 文件与 vendored KaTeX。
- 测试资产：`tools/test_*.mjs` 13 个测试脚本 + `tools/verify_*.py`；`package.json` **没有** `scripts.lint/typecheck/test`。
- 版本控制：**无 `.git`** —— 必须 `scan`。

## 评审范围与批次

| 批次 | 对象 | 视角/强度 | runId | 结果 |
|---|---|---|---|---|
| batch-1 | `lib/util.js` | quick（intent/correctness） | `run-20261116-190955-746b` | 6 minor，全部 accepted |
| batch-2 | `lib/gateway.js` | standard（intent/correctness/errors/security/contract；scan 模式跳过 tests 视角） | `run-20261116-193909-9bc6` | 首轮 17 minor（13 accepted + 4 判为 unit-scope 测试噪声 rejected），复评后 13/13 accepted 全命中、0 漏报。⚠️ 该 runId 的磁盘记录后来被 batch-2b 复评覆盖：首轮 17 条 findings 仅存于本 case 导出（findings.json/dispositions.json），磁盘上已无原始 aggregate 可对账 |
| batch-3 | `lib/pipeline.js` | standard（同 batch-2 lenses） | `run-20261116-203528-92c0` | 14 minor，全部 accepted；`review eval`：matched 14 / missed 0 / noise 0 / notEvaluated 23 → **pass** |
| batch-4 | `index.js`（Host：工具注册、HTTP API、任务队列） | standard（同 lenses，单文件 ~5k 行） | `run-20261116-204833-fc82` | 19 minor，全部 accepted；`review eval`：matched 19 / missed 0 / noise 0 → **pass** |
| batch-5 | `lib/library.js` | standard（同 lenses） | `run-20261116-205830-6e9b` | 2 major + 10 minor，全部 accepted；`review eval`：matched 12 / missed 0 / noise 0 → **pass**（修了 scan 模式把既有问题当阻断的门禁 bug） |
| batch-6 | `python/pageparse.py` | standard（同 lenses） | `run-20261116-210746-8607` | 8 minor，全部 accepted；`review eval`：matched 8 / missed 0 / noise 0 → **pass**（首个 Python 批次） |
| batch-7 | `python/floats.py` | standard（同 lenses） | `run-20261116-211500-f3ee` | 2 major + 18 minor，全部 accepted；`review eval`：matched 20 / missed 0 → **pass**；跨视角同行重复项部分被新去重合并（措辞差异大者仍分开，见 lessons R-15） |
| batch-8 | `python/render_paper.py`（4,731 行） | standard（同 lenses） | `run-20261116-212301-f41d` | 15 minor，全部 accepted；`review eval`：matched 15 / missed 0 → **pass** |
| batch-9 | `python/mathconv.py`（2,554 行） | standard（同 lenses） | `run-20261116-213124-06c8` | 12 minor，全部 accepted；`review eval`：matched 12 / missed 0 → **pass** |
| batch-10 | `client.js`（Web UI，4,871 行） | standard（同 lenses） | `run-20261116-214120-3f06` | 17 minor，全部 accepted；`review eval`：matched 17 / missed 0 → **pass**；首轮曾遇 2 次传输失败，重跑成功（重试代码已在 main，待重启生效） |
| batch-11 | `lib/workspace.js` | standard（同 lenses） | `run-20261116-215647-d27f` | 24 minor，全部 accepted；`review eval`：matched 24 / missed 0 → **pass** |
| batch-12 | `lib/notes-store.js` | standard（同 lenses） | `run-20261116-220227-4e65` | 16 minor，全部 accepted；`review eval`：matched 16 / missed 0 → **pass** |
| batch-13 | `assets/doc-reader.js`（2,184 行） | standard（同 lenses） | `run-20261116-220935-107c` | 1 major + 17 minor，全部 accepted；`review eval`：matched 18 / missed 0 → **pass** |
| batch-14 | `assets/graph-view.js`（3,848 行） | standard（同 lenses） | `run-20261116-221855-0557` | 14 minor，全部 accepted；`review eval`：matched 14 / missed 0 → **pass** |
| batch-15 | `assets/workbench.js`（6,108 行） | standard（同 lenses） | `run-20261116-222838-b669` | 15 minor，全部 accepted；`review eval`：matched 15 / missed 0 → **pass** |
| batch-16 | `lib/visual.js` | standard（同 lenses） | `run-20261116-223718-0297` | 13 minor，全部 accepted；首轮 1 个视角传输失败，重跑成功；`review eval`：matched 13 / missed 0 → **pass** |
| batch-17 | `lib/compare.js` | standard（同 lenses） | `run-20261116-224802-996e` | 6 minor，全部 accepted；`review eval`：matched 6 / missed 0 → **pass** |
| batch-18 | `lib/document.js` | standard（同 lenses） | `run-20261116-225217-90db` | 1 major + 9 minor，全部 accepted；`review eval`：matched 10 / missed 0 → **pass** |
| batch-19 | `lib/evidence.js` | standard（同 lenses） | `run-20261116-225831-7c48` | 16 minor，全部 accepted；`review eval`：matched 16 / missed 0 → **pass** |
| batch-20 | `lib/audit.js` | standard（同 lenses） | `run-20261116-230351-549f` | 14 minor，全部 accepted；`review eval`：matched 14 / missed 0 → **pass** |
| batch-21 | `lib/viewer-state.js` | standard（同 lenses） | `run-20261116-230848-cd83` | 1 major + 17 minor，全部 accepted；`review eval`：matched 18 / missed 0 → **pass** |
| batch-22 | `lib/alignment.js` | standard（同 lenses） | `run-20261116-231305-d25f` | 11 minor，全部 accepted；`review eval`：matched 11 / missed 0 → **pass** |
| batch-23 | `lib/skills.js` | standard（同 lenses） | `run-20261116-231724-694b` | 9 minor，全部 accepted；`review eval`：matched 9 / missed 0 → **pass** |
| batch-24 | `lib/skill-store.js` | standard（同 lenses） | `run-20261116-232159-73ce` | **1 blocker** + 16 minor，全部 accepted；`review eval`：matched 17 / missed 0 → **pass**（scan 语义下 blocker 不阻断 gate） |
| batch-25 | `lib/note-sessions.js` | standard（同 lenses） | `run-20261116-232552-70cc` | 16 minor，全部 accepted；首轮 1 视角传输失败，重跑成功；`review eval`：matched 16 / missed 0 → **pass** |
| batch-26 | `lib/graph.js`（2,041 行，首次启用单文件切分：2 个 1200 行单元） | standard（同 lenses） | `run-20261116-233634-8ec3` | 3 major + 27 minor 入基线；聚合实际产出 33 条，3 条因 **max-comments 上限**被丢弃（并非 style/docs：实为 security 1 条 + intent 1 条 + correctness 1 条），未做 disposition、不入基线；`review eval`：matched 30 / missed 0 → **pass** |
| batch-27 | `lib/katex-verify.js`（1,345 行 → 2 单元：1200+145） | standard，DSH 重启后新 lib（scan 跳过 tests、temperature=0、自动切分） | `run-20261117-180202-d659` | 1 major + 18 minor，全部 accepted；`review eval`：matched 19 / missed 0 → **pass** |
| batch-2b | `lib/gateway.js` 复评（新 lib 验证） | standard（新 lib：temperature=0 + scan lens + 去重） | `run-20261116-193909-9bc6` | 15 minor；对旧基线 eval：matched 13/13、noise 0。15 条全部并入基线（其中约 10 条与旧 13 条语义近重复——措辞差异大未被去重合并），gateway 基线合计 28 条；再次 eval **pass 28/28** |
| batch-28 | `python/extract_paper.py`（4,889 行 → 5 单元） | standard（新 lib，自动切分） | `run-20261117-182124-660a` | 30 minor 入基线；聚合实际产出 60 条，30 条因 **max-comments 上限**被丢弃（并非 style/docs：含 contract 6 / correctness 8 / errors 9 / security 3 / data 1 / intent 3，其中有不可信 PDF 文本的 ReDoS 与 katex_safe 契约违背），未做 disposition、不入基线；`review eval`：matched 30 / missed 0 / new 0 → **pass** |
| batch-29 | `python/pages_to_png.py` | standard（新 lib） | `run-20261117-184744-bc51` | 8 minor，全部 accepted；`review eval`：matched 8 / missed 0 → **pass** |
| batch-30 | `lib/llm.js`（3,657 行 → 4 单元） | standard（新 lib） | `run-20261117-185223-98fd` | 30 minor 入基线，全部 accepted；两次运行（首轮 1 视角 schema 失败，重跑完整）。聚合实际产出 45 条，15 条因 **max-comments 上限**被丢弃（含 1 条 security：translatePaper 把 provider 原始错误写进交付物 warnings——同类问题在其他文件是被 accepted 的），未做 disposition、不入基线；`review eval`：matched 30 / missed 0 → **pass** |

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
| scan 模式的既有代码缺陷被当成本次变更阻断（batch-5 实测 exit 2） | `lib/review.mjs` 给 scan findings 标 `preexisting=true`；`lib/gate.mjs` 对 scan 模式忽略 blocking（`gate.blockPreexisting=true` 可显式开启） |
| 多视角把同一问题按不同类别重复报（batch-7 实测） | `lib/aggregate.mjs` 新增同文件同行的相似标题跨类别合并（votes 取并集、severity 取最高）；CLI 新增 `review aggregate --run` 可无模型重算 |
| 超大单文件（>1200 行）单请求易触发传输失败/上下文过长 | `lib/plan.mjs` 新增 scan 模式单文件切分：按行区间切成多个 unit（`plan.splitSingleFileLines`，默认 1200），逐块评审并用行区间锚定；batch-26（graph.js 2041 行）实测 2 单元、无传输失败 |
| case 回归误报：跨文件/跨类别/措辞漂移 | `lib/eval.mjs`：按 scope 过滤 + 同文件近似行/标题相似度 + 类别族约束 |
| 路径/Windows/吞错误/审批元数据规则缺口 | `rules/lang-js-ts.md`、`rules/core-security.md`、`rules/core-concurrency.md` 新增条目 |

## 当前回归状态（诚实记录）

- batch-3：`review eval --run run-20261116-203528-92c0` → **pass**（matched 14 / missed 0 / noise 0 / notEvaluated 23）。
- batch-4：`review eval --run run-20261116-204833-fc82` → **pass**（matched 19 / missed 0 / noise 0 / notEvaluated 37）。
- batch-5：`review eval --run run-20261116-205830-6e9b` → **pass**（matched 12 / missed 0 / noise 0 / notEvaluated 56）；scan 模式门禁已修，`gate` 恢复 pass（exit 0）。
- batch-6（Python）：`review eval --run run-20261116-210746-8607` → **pass**（matched 8 / missed 0 / noise 0 / notEvaluated 68）。
- batch-7（Python）：`review eval --run run-20261116-211500-f3ee` → **pass**（matched 20 / missed 0 / noise 0 / notEvaluated 76）。
- batch-8（Python）：`review eval --run run-20261116-212301-f41d` → **pass**（matched 15 / missed 0 / notEvaluated 96）。
- batch-9（Python）：`review eval --run run-20261116-213124-06c8` → **pass**（matched 12 / missed 0 / notEvaluated 111）。
- batch-10（Web UI）：`review eval --run run-20261116-214120-3f06` → **pass**（matched 17 / missed 0 / notEvaluated 123）。
- batch-11：`review eval --run run-20261116-215647-d27f` → **pass**（matched 24 / missed 0 / notEvaluated 140）。
- batch-12：`review eval --run run-20261116-220227-4e65` → **pass**（matched 16 / missed 0 / notEvaluated 164）。
- batch-13：`review eval --run run-20261116-220935-107c` → **pass**（matched 18 / missed 0 / notEvaluated 180）。
- batch-14：`review eval --run run-20261116-221855-0557` → **pass**（matched 14 / missed 0 / notEvaluated 198）。
- batch-15：`review eval --run run-20261116-222838-b669` → **pass**（matched 15 / missed 0 / notEvaluated 212）。
- batch-16：`review eval --run run-20261116-223718-0297` → **pass**（matched 13 / missed 0 / notEvaluated 227）。
- batch-17：`review eval --run run-20261116-224802-996e` → **pass**（matched 6 / missed 0 / notEvaluated 240）。
- batch-18：`review eval --run run-20261116-225217-90db` → **pass**（matched 10 / missed 0 / notEvaluated 246）。
- batch-19：`review eval --run run-20261116-225831-7c48` → **pass**（matched 16 / missed 0 / notEvaluated 256）。
- batch-20：`review eval --run run-20261116-230351-549f` → **pass**（matched 14 / missed 0 / notEvaluated 272）。
- batch-21：`review eval --run run-20261116-230848-cd83` → **pass**（matched 18 / missed 0 / notEvaluated 286）。
- batch-22：`review eval --run run-20261116-231305-d25f` → **pass**（matched 11 / missed 0 / notEvaluated 304）。
- batch-23：`review eval --run run-20261116-231724-694b` → **pass**（matched 9 / missed 0 / notEvaluated 315）。
- batch-24：`review eval --run run-20261116-232159-73ce` → **pass**（matched 17 / missed 0 / notEvaluated 324）。
- batch-25：`review eval --run run-20261116-232552-70cc` → **pass**（matched 16 / missed 0 / notEvaluated 341）。
- batch-26：`review eval --run run-20261116-233634-8ec3` → **pass**（matched 30 / missed 0 / notEvaluated 357）；单文件切分后两个单元、无传输失败。
- batch-27（DSH 重启后新 lib）：`review eval --run run-20261117-180202-d659` → **pass**（matched 19 / missed 0 / notEvaluated 387）。
- batch-2b（重启后复评 gateway.js）：旧基线 matched 13/13、noise 0（此前的 tests 噪声与采样漂移消失）；新增 5 条并入基线后再 eval → **pass 28/28**。
- batch-28（extract_paper.py，5 单元）：`review eval --run run-20261117-182124-660a` → **pass**（matched 30 / missed 0 / new 0 / notEvaluated 421）。
- batch-29（pages_to_png.py）：`review eval --run run-20261117-184744-bc51` → **pass**（matched 8 / missed 0 / notEvaluated 451）。
- batch-30（llm.js，4 单元）：`review eval --run run-20261117-185223-98fd` → **pass**（matched 30 / missed 0 / notEvaluated 459）。
- batch-2：`--run run-20261116-193909-9bc6`（插件仍缓存旧 `lib/plan.mjs`，tests 视角未跳过；本机无重启）→ matched 13 / missed 0 / noise 2–4，exit 2；属运行时缓存而非代码回归。
- 新增 `review.temperature=0` 与 reviewer 传输重试后，**重启 DSH** 重跑 batch-2 预期稳定通过（重复运行结果一致）。
- eval 语义已按 run scope 过滤：其他批次基线在当前 run 中计 `notEvaluated`，不再误判漏报。

## 下一步

1. 重启 DSH 后重跑 batch-2（plan→run），确认 tests 视角消失、eval 转 pass。
2. batch-3/4/5 继续追加基线；误报出现时补 `rejected` 样例。
3. 把新增规则对应到 `review eval` 的稳定性观察（每次追加 run 都跑一次 eval）。
