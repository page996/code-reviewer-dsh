# ARCHITECTURE — 分层、数据流、运行目录、失败与降级

> 接口细节的唯一事实源是 [`../CONTRACT.md`](../CONTRACT.md)；本文只讲结构与边界，二者冲突时以 CONTRACT 为准。

## 1. 定位与边界

- 纯 Node（≥22.19、ESM、零外部依赖，只用 `node:` 内建 + `git` 命令）的**确定性评审核心**；
- 两个宿主共享同一核心：DSH Host 插件（开发中体验、软门禁）与独立 CLI（git hook / CI / 脚本）；
- skill 只提供方法论与判定标准，不手写 findings、不算票数、不编造行号。

**边界**：DSH 没有 git hook，`git commit/push` 是外部进程；DSH 内只能做「经 Harness 的写入/工具调用」的软门禁。**权威门禁必须落在 CI/远端**（branch protection + 确定性退出码）。

## 2. 分层

```text
┌─────────────────────────────────────────────────────────────────────┐
│ L3  Skill                                                          │
│   skills/ai-code-review/SKILL.md（R0–R6 状态机、L0–L3、硬规则）       │
│   references/{workflow,prompts,gates,ci,reporting,hooks,cases}.md   │
├─────────────────────────────────────────────────────────────────────┤
│ L2  宿主（同一份核心、同一套 schema/退出码）                          │
│   A) plugins/dsh  — ctx.tools 注册 review_*、ctx.commands 注册 /review│
│                      ctx.llm 包装为 llm.complete、软门禁、报告面板    │
│   B) bin/review.mjs — scope/plan/run/gate/report/all/scan/hook/…    │
├─────────────────────────────────────────────────────────────────────┤
│ L1  确定性核心 lib/（无 DSH import，可单测、可注入 fake llm）          │
│   config/dotenv → git → scope → rules → plan → store → llm/prompts  │
│   → review → position → filter → aggregate → report → gate → hooks  │
└─────────────────────────────────────────────────────────────────────┘
                                ▲
            可选：OCR delegate 适配器（只消费 JSON，不在本仓库范围）
```

模块职责见 CONTRACT §0；所有对外路径为**仓库相对 POSIX**（`server/a.ts`），输出不带盘符。

## 3. 数据流

整体链路（任务视角）：`scope → plan → review → position → filter → aggregate → report → gate`

| 阶段 | 模块 / 命令 | 输入 | 输出 |
|---|---|---|---|
| scope | `lib/git.mjs` + `lib/scope.mjs`；`review scope` / `review_scope` | mode/range/path、`config.scope` | `scope.json`（文件清单、排除原因、coverage） |
| plan | `lib/rules.mjs` + `lib/plan.mjs`；`review plan` / `review_plan` | `scope.json`、effort、规则包 | `plan.json`（units、lenses、逐 unit 规则） |
| review | `lib/review.mjs` + `lib/llm.mjs` + `lib/prompts.mjs`；`review run` / `review_run` | `plan.json`、契约、规则、模型 | `reviews.json`（每 unit×lens 原始输出）+ usage |
| position | `lib/position.mjs` | raw findings + unit 文件内容/新行集合 | `startLine/endLine/anchored`（锚不到置 false） |
| filter | `lib/filter.mjs` | 已定位 findings + unit diff | `keep/drop` 决策（证据不足保留） |
| aggregate | `lib/aggregate.mjs` | reviews + anchored + config | `aggregate.json`（findings 数组：fingerprint、票数、severity、status） |
| report | `lib/report.mjs`；`review report` / `review_report` | scope/plan/aggregate/gate/meta | `report.md`、`report.json`、`report.sarif` |
| gate | `lib/gate.mjs`；`review gate` / `review_gate` | aggregate + `gate.commands`/探测 | `gate.json`（checks、verdict、exitCode） |

说明：
- `report` 与 `gate` 互相引用——`gate.json.blocking[]` 进报告「门禁/阻断」节，报告的 gate 节取自同一份 `gate.json`；`review all` 内部按 CONTRACT §8 执行 `run → gate → report`（report 需要 gate 结论），`review report` 也可单独重跑。
- `review all` / `review scan` 把 `gate.exitCode` 作为进程退出码；`gate.json` 与退出码是 CI 的唯一判定依据。
- 轮次：`review run --rounds N`；第 2 轮是验证轮（已确认 findings + 其所在文件的 diff），finding fingerprint 跨轮幂等。

## 4. 运行目录

```text
<repo>/.review/
├── config.json                    # 配置（模板 templates/.review-config.json）
├── rules/*.md                     # 项目规则包（frontmatter: id/title/paths/severityHint）
└── runs/<runId>/                  # runId = run-YYYYMMDD-HHmmss-<4hex>
    ├── meta.json                  # 模式、参数、时间、模型 describe()
    ├── scope.json                 # CONTRACT §3
    ├── rules.json                 # 本次命中的规则快照
    ├── plan.json                  # CONTRACT §4
    ├── reviews.json               # 每个 (unit,lens) 的原始输出（可追溯）
    ├── aggregate.json             # 定位+过滤+聚合后的 findings
    ├── report.md / report.json / report.sarif
    └── gate.json                  # CONTRACT §7，含 exitCode
```

- `.review/` 默认 gitignore；报告作为 CI artifact 上传，不提交；CI 的临时副本放 `.review-ci/`。
- `latest` 由 `store.mjs::latestRun()` 解析（`--run latest` 可用），`review runs --json` 列出历史。
- 配置合并顺序：默认值 ← `$DSH_HOME/.dsh-code-review.json`（可选）← 仓库 `.review/config.json` ← CLI 参数；未知字段忽略。

## 5. 模型路由与「无预算上限」

- CLI：`lib/llm.mjs::createLlm({model})`，默认 `transport=anthropic` → `POST {base}/v1/messages`；base 默认 `https://api.deepseek.com/anthropic`（可由 `DEEPSEEK_BASE_URL`/`.env` 覆盖）。
- 模型固定目标：`deepseek-flash` + `reasoningEffort: max`；`maxTokens: null` 表示用传输默认，**不设 token/金额预算上限**。
- DSH 插件：用 `ctx.llm.stream` 包装成同一 `complete`；模型路由取宿主当前选择（`ctx.get('agentDefaultModel')?.currentSelection?.()`）以复用凭据，`reasoningEffort` 固定取 config（默认 max）；实际模型/effort 在报告与日志中回报。
- 无上限 ≠ 无成本：每次必须回报 usage（input/output/cache tokens、调用次数、耗时、轮次），写入 `report.json` 顶层 `usage`/`calls`/`durationMs` 与 md「成本」节。
- API key 只从环境/`.env` 读取（`DEEPSEEK_API_KEY`），**绝不写入任何输出文件或日志**。
- 重试：429/5xx/网络错误重试 2 次（1s/3s 退避）；4xx 不重试；连接/整流超时默认 300s。

## 6. 失败模式与降级

| 失败 | 表现 | 处理 | 退出码 |
|---|---|---|---|
| 无 git / 非仓库 | `GIT` 错误或目录无 `.git` | 改 `scan`（`mode=scan`，无 diff），报告显式声明 | 0/2/3/4 按后续 |
| 无 API key | `LLM_AUTH` | deterministic-only（scope/plan/gate/report），报告标注「LLM 未执行」；CI 严格红 | 5（若跑 run） |
| LLM 429/5xx/超时 | 重试 2 次后仍失败 | 稍后重跑同一 run，不得降级放行 | 5 |
| 模型输出非 JSON | `SCHEMA` | 同 (unit,lens) 重试 1 次；仍失败 → needs-human 记录，不吞 | 3（若有 needs-human） |
| 定位失败 | `anchored=false` | 保留原描述进 needs-human，不进 SARIF/行内评论 | 3 |
| 门禁命令失败/超时 | `checks[].exit != 0` | 修代码/命令/环境；豁免需改配置并写报告 | 4 |
| blocking findings | `gate.blocking[]` 非空 | 修完重跑；L1+ 不得口头放行 | 2 |
| 配置/引擎异常 | `CONFIG`/`SCHEMA`/内部错误 | 修配置/凭证；禁止当通过 | 5 |
| 用法错误 | 参数不合法 | 按 CLI 提示修 | 1 |
| hook 误拦 | 非零退出 | 修问题，或紧急时 `REVIEW_SKIP_HOOKS=1` 并在交付说明注明；CI 仍权威 | — |
| DSH API 漂移 | 插件加载/工具注册失败 | DSH 耦合集中在 `plugins/dsh/`；核心纯 JS 可单测、可退回 CLI | — |

## 7. 扩展点

- **规则**：`rules/*.md`（内置）+ `.review/rules/*.md`（项目），frontmatter 声明 `id/title/paths/severityHint/alwaysApply`，按文件匹配后注入 prompt。
- **视角**：10 个固定视角（intent/correctness/errors/concurrency/data/security/contract/tests/scope/history），effort 决定子集；`review.lenses` 可覆盖。
- **prompt**：`lib/prompts.mjs`（实现）+ `skills/.../references/prompts.md`（文档），两处必须同步。
- **门禁**：`gate.commands` 显式声明优先，其次 autodetect；本地 hook 与 CI 共用同一份。
- **经验**：`cases/<repo>/` 驱动规则/prompt 改进，`review eval --case` 回归。

## 8. 明确不做

- 不自动合并、不自动修复后直接推送；
- 不替代测试/CI/监控/回滚演练；
- 不在 DSH 内伪装 git hook，不宣称能拦截外部 `git commit`；
- 不做「无人审核的全自动门禁放行」。
