# code-reviewer-dsh

DSH 专属 code review 工具链：确定性的评审核心 + 双宿主（DSH Host 插件 / 独立 CLI）+ 升级版 `ai-code-review` skill + 真实 git hooks + GitHub Actions 门禁。

> English: A DSH-native code review toolchain — deterministic scope/plan/position/filter/aggregate/report/gate core, a DSH Host plugin, an upgraded `ai-code-review` skill, real git hooks, and CI as the authoritative gate.

参考 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0）的工程思想重写，**非代码复用**；目标是把「AI 写码 → 独立多视角评审 → 机器门禁 → 人工放行 → 逃逸沉淀」固化为可执行闭环。

## 它解决什么

- **漏审与覆盖率**：diff 内每个文件必须落 `reviewed` 或 `skipped(原因)`，不允许静默漏审。
- **假阳性与噪音**：10 视角独立评审 + 跨视角投票 + 保守过滤器 + `needs-human` 单列，避免把猜测塞进 blocker。
- **行号可信**：finding 必须带 `existing_code` 滑窗定位；锚不到就显式 `anchored=false`，禁止伪造行号。
- **门禁可复现**：结论只看 `gate.json` 与确定性退出码（0/2/3/4/5），不看模型自然语言。
- **经验可回归**：每个逃逸缺陷进 `cases/<repo>/`，规则/prompt 改动必须能追溯到 case。

## 架构

```text
┌──────────────────────────────────────────────────────────────────┐
│ L3  Skill  skills/ai-code-review（R0–R6、放行判定、逃逸沉淀）       │
├──────────────────────────────────────────────────────────────────┤
│ L2  宿主   A) DSH Host 插件 plugins/dsh（工具/命令/面板/软门禁）    │
│            B) 独立 Node CLI bin/review.mjs（git hook / CI / 脚本）  │
├──────────────────────────────────────────────────────────────────┤
│ L1  确定性核心 lib/（纯 Node，无 DSH 依赖，可单测）                 │
│   scope → plan → review(LLM) → position → filter → aggregate     │
│   → report(md/json/sarif) → gate → store(.review/runs/<runId>/)   │
└──────────────────────────────────────────────────────────────────┘
                  ▲ 两条宿主共享同一配置、规则、schema、退出码
                  ▲ 可选：OCR delegate 适配器（不在本仓库范围）
```

## 能力矩阵

| 能力 | 载体 | 需要模型 | 说明 |
|---|---|---|---|
| 选文件 / 覆盖率 | `review scope` / `review_scope` | 否 | 6 道选择闸门 + 逐文件 `excludeReason`，`coverage.complete` 硬性 |
| 打包 / 规则绑定 / 视角 | `review plan` / `review_plan` | 否 | 目录分组、≤10 文件 / ≤400 行每 unit |
| 多视角评审 | `review run` / `review_run` | 是 | 10 视角、并发、≥2 票才保留 major/blocker |
| 行级定位 | `lib/position.mjs` | 否 | `existing_code` 滑窗，失败显式未锚定 |
| 假阳性过滤 | `lib/filter.mjs` | 是 | 只删本 diff 能证伪的，证据不足保留 |
| 聚合 / 分级 | `lib/aggregate.mjs` | 否 | 指纹去重、投票、preexisting 不阻塞 |
| 报告 | `review report` / `review_report` | 否 | md / json / SARIF 2.1.0 |
| 门禁 | `review gate` / `review_gate` | 否 | 确定性退出码，唯一阻断依据 |
| git hooks | `review install-hooks`、`review hook` | 视模式 | 默认 fast：pre-commit 只跑确定性命令（无 LLM）；可跳过 |
| CI | `.github/workflows/{ci,review,hooks-contract}.yml` | 是（review） | 权威门禁、SARIF、PR 评论 |
| DSH 插件 | `plugins/dsh` | 是 | `review_*` 工具 + `/review` 命令 |
| skill | `skills/ai-code-review` | — | 装到 `.dsh/skills/` 或 `~/.dsh/skills/` |

## 验证状态（本机实测，2026-11）

| 项 | 证据 |
|---|---|
| 单测 | `node --test "test/**/*.test.mjs"` → **110 tests pass**（含 hooks 契约、插件、eval、SIL/scan 语义） |
| 真实 git hooks | `node test/hooks.contract.mjs` → 5/5 PASS（本地 Windows + CI ubuntu 均绿） |
| GitHub Actions | `ci.yml`、`hooks-contract.yml` 绿；PR #1 上 `review.yml` 用 `DSH_API_KEY` 真实跑通 LLM 评审 → SARIF 上传 + 单条幂等评论 + job success |
| DSH Host 插件 | `install_bundle` 成功；6 个 `review_*` 工具 + `/review` 命令实机可用（含 `repo` 参数、输出 schema 清洗、单文件切分） |
| skill v2 | 已装到项目 `.dsh/skills/` 与全局 `~/.dsh/skills/`，技能目录已刷新 |
| 样例仓库真实评审 | `dsh-paper-translator-v8`：**31 个批次 / 489 条 findings（485 accepted，含 1 blocker + 11 major）**，覆盖 lib / index.js / client.js / assets / python；`review eval` 全部 **missed 0 / noise 0** |
| 经验沉淀 | 20 条规则库更新（JS/TS、Python、安全、错误、数据、契约、并发）+ prompt 4 处 + case lessons R/P/E 台账；每个规则改动可追溯到 case |

已知未做（不在本仓库范围）：PR #1 合并留待人工；DSH 内 UI 面板 / 硬门禁 / OCR delegate 适配器为 P4 可选项。

## 快速开始

### 1. 本地 CLI

要求 Node ≥22.19（`package.json` engines），零外部依赖。

```powershell
cd <repo>
npm link                        # 可选：把 review 装到 PATH；否则直接用 node bin/review.mjs
node bin/review.mjs scan --path . --effort quick --json
node bin/review.mjs all --mode range --base main --effort standard --json
node bin/review.mjs gate --run <runId>
node bin/review.mjs runs --json
node --test "test/**/*.test.mjs"
```

### 2. DSH 插件 + skill

```text
# 1) 插件：用 plugin_manager 安装本地 bundle（target 用 plugins/dsh 的绝对路径）
# 2) 新开 DSH 会话 → 获得 review_scope / review_plan / review_run / review_gate /
#    review_report / review_ledger 工具与 /review 命令
# 3) skill：把 skills/ai-code-review 复制到项目的 .dsh/skills/ 或全局 ~/.dsh/skills/
```

```powershell
Copy-Item -Recurse -Force <repo>\skills\ai-code-review .dsh\skills\ai-code-review
```

### 3. GitHub Actions

1. 复制 `.github/workflows/{ci,review,hooks-contract}.yml` 到目标仓库；
2. 配置 Secret `DSH_API_KEY`（也接受 `DEEPSEEK_API_KEY`；可选 `DEEPSEEK_BASE_URL`）；
3. branch protection：要求 `ci.yml` 与 `review.yml` 的 check 必过，push 后 dismiss 旧 approval；
4. 严格模式：同仓 PR 缺 secret → job 必须红；fork PR 无 secret → 只跑确定性门禁并在评论标注未评审。

### 4. 配置与模板

```powershell
New-Item -ItemType Directory -Force .review | Out-Null
Copy-Item <repo>\templates\.review-config.json .review\config.json
Copy-Item <repo>\templates\REVIEW.md .
Copy-Item <repo>\templates\AGENTS.md .
```

`.review/config.json` 里改 `gate.commands`（唯一事实源，本地 hook 与 CI 共用），模型固定 `deepseek-flash` / `reasoningEffort: max` / 不设预算上限。

## 目录结构

```text
code-reviewer-dsh/
├── CONTRACT.md              # 接口契约（唯一事实源）
├── package.json             # name dsh-code-reviewer, bin.review
├── bin/review.mjs           # CLI：scope/plan/run/gate/report/all/scan/hook/install-hooks/runs/aggregate/eval
├── lib/                     # 确定性核心 + LLM 编排（scope/plan/rules/review/position/filter/aggregate/report/gate/store/hooks/config/llm/prompts）
├── rules/*.md               # 内置规则包（frontmatter + 正文）
├── plugins/dsh/             # DSH bundle：工具、/review 命令、配置 patch
├── skills/ai-code-review/   # skill v2（SKILL.md + references + README）
├── templates/               # .review-config.json、REVIEW.md、AGENTS.md、contract.md、pr-comment.md
├── cases/                   # 经验沉淀：每个样例仓库一个目录
├── docs/ARCHITECTURE.md     # 架构与数据流
├── hooks/README.md          # git hooks 安装/模式/排错说明
├── .githooks/               # pre-commit / pre-push（install-hooks 写入）
├── .github/workflows/       # ci.yml / review.yml / hooks-contract.yml
└── test/                    # node --test 单测 + hooks 契约测试（test/hooks.contract.mjs）
```

## 门禁语义（务必理解）

- **DSH 内是软门禁**：只约束经过 Harness 的写入与流程，拦不住外部 `git commit`，也不能替代 CI。
- **git hooks 是本地快反馈**：可被 `REVIEW_SKIP_HOOKS=1` 或 `--no-verify` 跳过；默认 `fast` 下 pre-commit 只跑确定性命令、不调 LLM。
- **CI/远端是权威门禁**：`gate.json` 与确定性退出码决定 job 成败，branch protection 决定能否合并。
- **退出码**：`0` 通过；`2` blocking findings；`3` needs-human；`4` 必需门禁失败；`5` 引擎/配置错误；`1` 用法错误。
- **模型**：`deepseek-flash` + `reasoningEffort: max`；不设 token/金额预算上限，但每次必须回报 usage（tokens/调用数/耗时）。不设上限 ≠ 不控成本。

## 与 OpenCodeReview 的关系与致谢

本项目的**设计思想**来自 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0，trial fork: `page996/code-review-toolkit-trial1`）：

- 选文件闸门（binary / secret / user exclude / user include / unsupported ext / default path / deleted / too large）；
- 大 diff 文件打包与按组并发；
- glob → 规则文本匹配并注入 prompt；
- `existing_code` 滑窗定位 + 「只删本 diff 能证伪」的过滤反射；
- 报告契约向它的 delegate JSON 对齐，保留可选适配空间。

只借鉴思想与契约，**未复用其代码**，不 fork Go 核心（Go 版本/覆盖率/ASCII-English 约束与 DSH 场景不匹配）。其内置规则资产若日后引入，将单独标注 Apache-2.0 来源与修改说明。

## License

MIT（本仓库原创代码与文档）。引用的第三方思想/契约按其原许可证（Apache-2.0）致谢，不改变本仓库许可证。
