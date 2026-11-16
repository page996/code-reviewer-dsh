# 工作流（R0–R6）：输入 / 输出 / 命令 / 失败降级

| 阶段 | CLI | DSH 工具 | 关键产物 |
|---|---|---|---|
| R0 契约 | `review all --contract REVIEW.md` 或 `review scan --path D` | `review_scope` | 契约文档、run 目录 |
| R1 准备 | `review scope` → `review plan --run R` | `review_scope` / `review_plan` | `scope.json`、`plan.json` |
| R2 评审 | `review run --run R --effort standard\|deep` | `review_run` | `reviews.json`、`aggregate.json` |
| R3 门禁 | `review gate --run R` | `review_gate` | `gate.json` |
| R4 放行 | `review report --run R --format md` | `review_report` | `report.md`、签字记录 |
| R5 发布 | 部署系统 / CI（本工具不部署） | — | 烟测与回滚记录 |
| R6 沉淀 | `review eval --case cases/<repo>` | `review_ledger` | `cases/<repo>/lessons.md` |

`R` = scope 返回的 `runId`。一次 `review all` / `review scan` 串联 R1–R4 并写全部产物；`--json` 时 stdout 只出一个 JSON 对象（含 `runId`、产物路径、counts、usage、exitCode）。

## R0 契约
- 输入：issue/需求/验收标准；仓库 `REVIEW.md`、`AGENTS.md`。
- 输出：任务契约（目标/验收/非目标/风险级别/允许范围/回滚）+ `runId`。
- 命令：有 git 且只审本次改动 → `node bin/review.mjs all --mode range --base main --contract REVIEW.md --json`；无 git 或全仓 → `node bin/review.mjs scan --path <dir> --effort deep --json`。
- 证据：`templates/contract.md` 填完；`--json` 输出的 `runId` 与产物路径。
- 失败降级：契约缺失 → 停下问人；有 git 但无远端 base → `--mode workspace`。
- 失败降级：`review` 命令不存在 → 检查 Node ≥22.19 与 `node bin/review.mjs` 路径，不手工替代。

## R1 准备
- 输入：runId、`--effort`、`.review/config.json`、`rules/*.md`。
- 输出：`scope.json`（文件清单/排除原因/覆盖率）、`plan.json`（units/rules/lenses）。
- 命令：`node bin/review.mjs scope --mode range --base main --head HEAD --json` → `node bin/review.mjs plan --run <runId> --effort deep`。
- 覆盖率验收（硬性）：`coverage.complete == true` 且 `coverage.unreviewed == []`；每个文件 `reviewable=true` 或 `excludeReason` 属于契约枚举；`plan.json.skippedFiles` 解释全部跳过项。
- 证据：把 `counts` 与排除原因表贴进报告；effort 与风险级别一致（L1+ 不用 quick）。
- 失败降级：`GIT` 错误（非仓库/无 base）→ 换 `--mode workspace|staged|scan`；diff 太大 → 拆 PR，不调大 unit 上限硬塞。
- 禁止：覆盖率不足却把「没发现问题」当结论。

## R2 评审
- 输入：`plan.json`、rules、契约、测试证据（可选）。
- 输出：`reviews.json`（每个 unit×lens 的原始输出）、`aggregate.json`（定位+过滤+聚合后的 findings）。
- 命令：`node bin/review.mjs run --run <runId> --effort standard`；高风险 `--effort deep`；需要验证轮加 `--rounds 2`。
- 证据：报告中的视角/轮次/票数；needs-human 逐条处置；`usage`（tokens、调用数、耗时）。
- 失败降级：LLM 鉴权失败 → 退出码 5，修 key，禁止降级放行；输出非 JSON → 同一 (unit,lens) 重试一次，仍失败记 needs-human（不吞）。
- 轮次：第 1 轮全量多视角；`rounds>=2`（deep 强制）时跑验证轮：只审已确认 findings + 其所在文件的新 diff，判断是否修复；仍不收敛 → 停。

## R3 门禁
- 输入：聚合结果（blocking/needsHuman）、`gate.commands` 或自动探测。
- 输出：`gate.json`（checks/verdict/blocking/exitCode）。
- 命令：`node bin/review.mjs gate --run <runId>`；DSH `review_gate({runId})`。
- 证据：每条命令的 `exit`、`durationMs`、`stdoutTail`；verdict；退出码。
- 失败降级：必需命令失败 → 退出码 4，修命令/环境/代码；本机跑不了 → 交 CI 跑同一命令，不口头豁免；超时（`gate.timeoutMs`）按失败。
- 禁止：把 `needs-human` 当 blocker 硬压，或把非 0 退出码改写成 0。

## R4 放行
- 输入：`report.md`、`gate.json`、契约、风险级别。
- 输出：签字记录（人/时间/commit SHA/四问答案）、PR 评论。
- 命令：`node bin/review.mjs report --run <runId> --format md --out review-report.md`；DSH `review_report`。
- 证据：四问答案 + gate 证据 + 覆盖率 + 成本；L1+ 缺一不签。
- 失败降级：无法签字 → 缩范围/补测试/拆 PR；不得用「Agent 说没问题」替代。
- 禁止：Agent 代签；签 branch 名而非 commit SHA。

## R5 发布 / 回滚
- 输入：签字记录、灰度/flag 方案、回滚脚本。
- 输出：发布记录、烟测结果、监控确认。
- 命令：由部署系统/CI 执行；本工具只产出报告与门禁结论。
- 证据：烟测清单、回滚演练记录（放项目发布文档，不塞进 `.review/`）。
- 失败降级：任何烟测失败 → 立即关 flag/回滚，再定位。

## R6 逃逸沉淀
- 输入：发布后/人工发现的缺陷与误报。
- 输出：`cases/<repo>/{README.md,findings.json,dispositions.json,lessons.md}`；`findings.json` 从该 run 的 `aggregate.json.findings` 导出，不手写。
- 命令：`node bin/review.mjs eval --case cases/<repo> --json`；`node bin/review.mjs runs --json` 做历史对比。
- 证据：每条 lesson 标注落到 `rules/*.md` / `references/prompts.md` / 回归用例的具体文件。
- 失败降级：暂时无法回归 → 在 `lessons.md` 标「待实现规则」，不要只写在聊天里。

## 降级路径（必须显式报告）

### A. 无 git → scan 模式
- 判定：目录无 `.git`（`Test-Path .git` 为 false）或 git 命令报 `GIT` 错误。
- 命令：`node bin/review.mjs scan --path <dir> --effort deep --json`；等价于 `scope --mode scan --path <dir>` + `plan` + `run` + `gate` + `report`。
- 语义差异：`mode=scan`，文件 `status=existing`，无 diff 行；不存在「本次新增」；`preexisting=true` 不阻塞（`gate.blockPreexisting=false`）。
- 定位：`existing_code` 匹配不到 → `anchored=false` → needs-human；禁止伪造行号。
- 必报内容：报告首行写「scan 模式：全量既有代码，无 diff；用于找缺陷与补规则，不能作为 PR 放行依据」。
- 禁止：用 scan 结果批准 L1+ 变更。

### B. 无 API key → deterministic-only 降级
- 判定：`$env:DEEPSEEK_API_KEY` 为空且 `.env` 无该键。
- 能跑：`scope`、`plan`、`gate`、`report`；**不能跑** `run`，也不要跑 `all`/`scan` 的 LLM 段（会以退出码 5 失败）。
- 命令：`node bin/review.mjs scope ...` → `node bin/review.mjs plan --run <runId>` → `node bin/review.mjs gate --run <runId>` → `node bin/review.mjs report --run <runId>`。
- 报告要求：`report.md` 顶部标注「LLM 评审未执行（无 DEEPSEEK_API_KEY）：只跑了确定性检查」；R4 不得据此批准 L1+。
- CI 严格模式：缺 secret 必须红（fork PR 例外，见 `ci.md`）；「无 key 但 job 绿」= 违规。
- 禁止：把 deterministic-only 的 gate 退出码 0 说成「评审通过」。

### C. 其他失败
| 失败 | 退出码 | 处置 |
|---|---|---|
| 配置/引擎错误（`CONFIG`/`SCHEMA`/`LLM`） | 5 | 修配置/凭证；不得当通过 |
| 用法错误（参数不对） | 1 | 按 CLI 提示修参数 |
| LLM 429/5xx/超时 | 重试 2 次仍失败 → 5 | 稍后重跑同一 run |
| LLM 输出非 JSON | 单 (unit,lens) 重试 1 次 | 仍失败 → needs-human 记录，不吞 |
| 定位失败 | 不单独退出 | `anchored=false` → needs-human，报告可见 |
