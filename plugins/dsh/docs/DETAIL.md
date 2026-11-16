# 代码评审（DSH Host 插件）

`@local/dsh-code-review` 把 `dsh-code-reviewer` 的确定性评审核心包装成 DSH Host 能力：6 个工具、1 个 `/review` 命令，以及可选的只读 HTTP 路由。所有结论来自仓库内的 `lib/*.mjs`，不 spawn CLI，不重复实现评审逻辑。

## 做什么

- **确定性范围**：按 Git 工作区 / 暂存区 / 区间 / 提交，或直接扫描普通目录，得到纳入评审的文件清单与排除原因。
- **计划与规则**：按目录与行数预算把文件打包成评审单元，绑定内置/项目规则并分配视角（intent、correctness、errors、security、tests、contract 等）。
- **模型评审**：每个（单元 × 视角）调用一次 Host `ctx.llm.stream`（默认跟随当前会话模型），用 `reasoningEffort` 控制思考强度；结果做行号定位与保守的假阳性过滤。
- **聚合**：按 `(file, startLine, category)` 去重、跨视角投票、保留最高严重级别；证据不足的降为 needs-human。
- **门禁**：执行配置的确定性命令（测试 / lint / typecheck，可自动探测），结合阻断级 findings 输出 `verdict` 与退出码 0/2/3/4/5。
- **报告**：`report.md`、`report.json`、`report.sarif`（SARIF 2.1.0），并回报 token 用量。产物只写目标仓库的 `.review/runs/<runId>/`。

## 工具

调用顺序固定；`runId` 均可省略（表示最近一次运行）。

| 工具 | 参数 | 何时使用 | 返回 |
| --- | --- | --- | --- |
| `review_scope` | `mode`(workspace/staged/range/commit/scan)、`base`、`head`、`path`、`repo` | 写码或切分支后，确定本次评什么 | `runId`、`mode`、`counts`、文件清单（≤40 条）、`artifacts` |
| `review_plan` | `runId`、`effort`(quick/standard/deep) | scope 之后，决定评审单元与视角 | `effort`、`lenses`、单元清单（≤30 条）、`artifacts` |
| `review_run` | `runId`、`effort`、`lenses`、`rounds` | plan 之后，真正跑模型评审（耗时最长）；缺少计划时会自动生成 | `counts`{blocker,major,minor,needsHuman,dropped}、`verdict`、`exitCode`、`usage`、`artifacts` |
| `review_gate` | `runId` | run 之后，跑测试/lint 并得到阻断结论；也可在 review_run 之前只跑确定性门禁 | `verdict`、`exitCode`、`counts`、`blocking`、`checks`（stdout 尾部已截断） |
| `review_report` | `runId`、`format`(all/md/json/sarif) | gate 之后，产出人类/CI 可消费的报告 | `artifacts`、`verdict`、`exitCode` |
| `review_ledger` | `action`(list/show/latest)、`runId` | 回溯旧运行、确认上次评审证据；只读不调模型 | 运行清单或单次运行的 `counts`/结论/前 10 条 findings/产物 |

工具失败不抛异常：返回 `{ "error": { "code": "...", "message": "..." } }`。错误信息会去掉绝对路径并脱敏 key/token。

`output.render` 只输出一行摘要，避免把大 JSON 灌回上下文；详细内容在 `artifacts` 指向的文件里。

## `/review` 命令

`/review` 对当前工作目录跑完整流水线：scope → plan → 模型评审 → gate → report。
- 目录不是 Git 仓库时自动用 `scan`；是 Git 仓库默认 `workspace`。
- 可带参数：`/review staged`、`/review range main`、`/review scan quick`、`/review --mode commit --base HEAD~1`。
- 结果是一行摘要（runId、可评审文件数、findings 计数、聚合/门禁结论、产物目录），完整结果写入 `.review/runs/<runId>/`。
- 同一时间只允许一个 `/review` 在跑；重复调用返回错误提示。

## 可选 HTTP API

当 Host 提供 `webServer` 时注册两条只读路由（缺失时静默跳过，不影响插件激活）：

- `GET /code-review/runs` — 当前工作目录下最近 100 次运行的摘要（JSON）。
- `GET /code-review/runs/<runId>/report.json` — 直接返回该运行的 `report.json`。

路由只读、`cache-control: no-store`、runId 做白名单校验（防路径穿越），不暴露绝对路径或任何凭据。

## 配置

插件配置（Plugin Settings 里的 `config`，或 `cordis.patch.yml` 的 `config`）只使用契约配置段，会覆盖仓库 `.review/config.json` 的同名字段（仓库配置仍作为下层被读取）：

```json
{
  "model": {
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "reasoningEffort": "max",
    "maxTokens": null
  },
  "review": { "effort": "standard", "concurrency": 4, "filter": true },
  "gate": { "commands": ["npm test", "npm run lint"], "autodetect": true, "blockOn": ["blocker", "major"] }
}
```

- `model.provider` / `model.model`：模型路由。都不设时使用 `agentDefaultModel.currentSelection()`（当前会话模型），再兜底 `deepseek-official` / `deepseek-flash`。仓库 `.review/config.json` 里的 `model.model` 只有在显式设为非默认值时才作为路由依据，避免默认值覆盖会话选择。
- `model.reasoningEffort`：默认 `max`。
- `review.effort`：默认 `standard`；`quick` 用 2 个视角，`deep` 用全部视角且建议 `rounds>=2`。
- `gate.commands`：显式门禁命令；为空且 `gate.autodetect !== false` 时按 `package.json` 的 lint/typecheck/test 等自动探测。

后续步骤（plan/run/gate/report）以 `review_scope` 时写入 `meta.json` 的配置快照为基础，保证同一 run 可复现；当前仓库配置只作为快照缺失时的兜底。`review_run` 的 `effort`/`lenses`/`rounds` 参数仍会覆盖快照中的对应值。

## 安装 / 验证

前提：Node ≥ 22；插件从本仓库安装（需要同仓库的 `lib/`、`rules/` 作为运行时依赖）。

1. 语法自检：`node --check plugins/dsh/index.js`
2. 运行插件单测（临时目录 + 假 ctx + 假 llm，无网络）：

   ```powershell
   node --test test/plugin.test.mjs
   ```

3. 安装到当前 profile（两种等价方式，选一）：
   - DSH 内调用 `plugin_manager` 的 `install_bundle`，`target` 填绝对包目录：`<repo>/plugins/dsh`。
   - 或终端执行：`dsh plugin --profile <profile> add <repo>/plugins/dsh`。
4. 验证：
   - Plugin Manager / `cordis_inspect_query`（host `Tool.listTools`）能看到 `review_scope`…`review_ledger` 6 个工具与 `/review` 命令；
   - 新会话里对当前仓库依次调用 `review_scope` → `review_plan` → `review_run`，或直接 `/review`；
   - `artifacts.runDir` 下出现 `scope.json`、`plan.json`、`reviews.json`、`aggregate.json`、`gate.json`、`report.*`；
   - 若 Host 提供 webServer，`GET /code-review/runs` 返回 JSON 列表。

## 产物

`.review/runs/<runId>/`（`report.outDir` 可改）：

```
meta.json  scope.json  rules.json  plan.json  reviews.json
aggregate.json  findings.json  gate.json  report.md  report.json  report.sarif
```

`reviews.json` 保留每个（单元 × 视角）的原始输出、定位后的 findings 与累计 usage；`aggregate.json` 是去重/投票/分级后的最终 findings 与 `blocking`；`findings.json` 是面向报告/下游消费的聚合结果副本（与 CLI 产物同名同结构）。工具返回的 `artifacts` 都是仓库相对 POSIX 路径。

## 限制

- **软门禁**：`review_gate` 只返回 `verdict` / `exitCode` / `blocking`，不会拦截工具调用，也不会阻止会话继续；真正的阻断需要 CI 或 git hook 使用同一份 `report.json` / 退出码语义。
- **不在 DSH 内装 git hook**：插件不写 `.git/hooks`、不改 `core.hooksPath`。需要提交前门禁请在终端执行 CLI：`review install-hooks`。
- **依赖本仓库**：插件通过相对路径加载 `lib/*.mjs` 与 `rules/*.md`，从本 checkout 本地目录安装可用；单独打包发布需要把 `lib/`、`rules/` 一并带上，否则工具返回 `ENGINE_UNAVAILABLE`。
- **模型请求由 Host 发出**：插件不读取、不写入、不记录任何 API key；模型能力、上下文窗口和配额取决于会话模型与 Host 配置。
- **无 token 预算上限**：契约要求不设评审预算，deep 模式 + 大 diff 会产生较多调用和费用；`usage` 只做事后统计。
- **门禁命令以当前用户权限执行**：`gate.commands` 会在被评审仓库里跑测试/lint，只应评审可信仓库。
- **跨仓库运行**：`runId` 默认在当前工作目录的 `.review/runs` 下解析。`review_scope` 指定了别的 `repo` 时，同一次插件进程内仍可按 runId 继续，跨进程/重启后请在对应仓库目录下调用。
- **非 Git 模式**：`scan` 没有 diff 行，findings 依赖 `existing_code` 定位；定位不到的会标记为未锚定但仍保留（needs-human 区）。
