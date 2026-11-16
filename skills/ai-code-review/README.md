# ai-code-review v2 — 安装 / 触发 / 版本对应 / 卸载

DSH skill：把「AI 写码 → 独立多视角评审 → 确定性门禁 → 人工放行 → 逃逸沉淀」固化为可执行闭环。
方法论在 skill，执行由 [`dsh-code-reviewer`](../../README.md) 提供（CLI 与 DSH 工具），不要手工伪造 findings 或行号。

## 目录结构

```text
skills/ai-code-review/
├── SKILL.md                     # 触发条件 + 核心原则 + L0–L3 + R0–R6 + 硬规则 + 自检
├── README.md                    # 本文件
└── references/
    ├── workflow.md              # 每阶段输入/输出/命令/证据/失败降级（含无 git、无 key）
    ├── prompts.md               # 10 视角 reviewer、JSON 契约、filter/红队/聚合/修复批次
    ├── gates.md                 # 门禁探测、失败处理、退出码、branch protection
    ├── ci.md                    # GitHub Actions（PR/SARIF/评论/fork）+ GitLab 对照
    ├── reporting.md             # md/json/sarif 字段、行内评论定位、needs-human、成本
    ├── hooks.md                 # pre-commit/pre-push 边界、fast/full、逃生口
    └── cases.md                 # 经验飞轮、dispositions 四态、review eval
```

## 安装

skill 必须**直接**位于 skills 根目录下（不能嵌套多层）。二选一：

### 项目级（推荐）

```powershell
# 在项目根目录执行；把 <repo> 换成 code-reviewer-dsh 的本地路径
New-Item -ItemType Directory -Force .dsh\skills | Out-Null
Copy-Item -Recurse -Force <repo>\skills\ai-code-review .dsh\skills\ai-code-review
```

### 全局

```powershell
Copy-Item -Recurse -Force <repo>\skills\ai-code-review $env:USERPROFILE\.dsh\skills\ai-code-review
# 或（设置了 DSH_HOME 时）
Copy-Item -Recurse -Force <repo>\skills\ai-code-review $env:DSH_HOME\skills\ai-code-review
```

> 项目根 = 包含 `.git` 的最近祖先目录；没有 `.git` 时用当前工作目录。项目级优先于全局，同名 skill 以更近一层为准。
> 安装/修改后开新会话（或等目录刷新）再使用；skill 目录会自动刷新到会话目录。

## 触发方式

- **自动**：在真实代码仓库里写码/改码/修 bug/加测试/改构建配置，或评审真实 diff/PR 时，模型按 `SKILL.md` 的 `description` 加载。
- **手动**：支持 `/name` 的界面输入 `/ai-code-review`；两个调用开关默认都开。
- **只允许手动**：frontmatter 加 `disable-model-invocation: true`；**只允许受信调用**：再加 `user-invocable: false`。
- 不适用场景（讨论、写作、方案、工具选型、聊天里的代码片段）skill 会明确说「不适用」，不要强行套流程。

## 与工具版本对应

| 组件 | 版本/标识 | 说明 |
|---|---|---|
| skill | v2（本目录） | 对应 `CONTRACT.md` schemaVersion 1 |
| 核心 + CLI | `dsh-code-reviewer` 0.1.0，`node bin/review.mjs` | 需 Node ≥22.19 |
| DSH 插件 | `@local/dsh-code-review`（`plugins/dsh`） | 工具 `review_scope/plan/run/gate/report/ledger` + `/review` 命令 |
| 模型 | `deepseek-flash`，`reasoningEffort: max` | 无 token/金额预算上限；usage 必须回报 |
| 配置 | `.review/config.json` | 模板 `templates/.review-config.json` |

升级 skill 或工具时同步看 `CONTRACT.md` 的 CLI/退出码/产物路径；skill 里的命令与工具不一致时，以 `CONTRACT.md` 为准并提 issue。

## 最短使用路径

```powershell
# 1) 项目根放两份口径（模板见 <repo>\templates\）
Copy-Item <repo>\templates\REVIEW.md .
Copy-Item <repo>\templates\AGENTS.md .

# 2) 初始化配置
New-Item -ItemType Directory -Force .review | Out-Null
Copy-Item <repo>\templates\.review-config.json .review\config.json

# 3) 跑一次（有 git → range；无 git → scan）
node <repo>\bin\review.mjs all --mode range --base main --effort standard --json
node <repo>\bin\review.mjs scan --path . --effort deep --json
```

## 卸载

```powershell
# 1) 移除 skill 目录（项目级 / 全局按安装位置）
Remove-Item -Recurse -Force .dsh\skills\ai-code-review

# 2) 如装过 git hooks，先还原 core.hooksPath（保留 .githooks 文件）
node <repo>\bin\review.mjs install-hooks --uninstall

# 3) 可选：删除运行产物与配置（.review/ 默认已 gitignore）
Remove-Item -Recurse -Force .review
```

DSH 插件用 `plugin_manager` 卸载对应 bundle；卸载后 `review_*` 工具与 `/review` 命令消失，但 CLI 与 CI 不受影响。

## 边界

DSH 内工具是**软门禁**（只约束本会话流程），git hook 可被 `REVIEW_SKIP_HOOKS=1` 跳过，**权威门禁是 CI/远端 branch protection**。skill 不替代测试、CI、监控与回滚演练。
