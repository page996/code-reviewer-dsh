# GitHub Actions 启用与门禁配置

本仓库的权威门禁是 **GitHub Actions**（客户端 git hooks 只是本地快速网）。本页是仓库管理员的一次性配置清单。

## 1. 必配 Secret

LLM 评审需要仓库级 Secret（`review.yml` 接受两个名字，同时存在时 `DSH_API_KEY` 优先）：

1. 打开 **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `DSH_API_KEY`（也接受 `DEEPSEEK_API_KEY`）
3. Secret: 你的 DeepSeek API Key（`sk-...`）

> 也可用 `gh secret set DSH_API_KEY --repo page996/code-reviewer-dsh`（本机未安装 `gh` 时用网页）。

配置后的行为（`review.yml`）：

| 场景 | 行为 |
|---|---|
| 同仓库 PR + 有 Secret | 确定性门禁 + `deepseek-flash`（reasoningEffort=max）完整评审 + SARIF + PR 评论 |
| 同仓库 PR + 无 Secret | **按设计失败**，并输出明确的 Secret 配置指引（严格模式，不静默跳过） |
| Fork PR + 无 Secret | GitHub 不向 fork 工作流暴露 Secret：跳过 LLM，只跑确定性门禁，并在 PR 评论里显式说明 |
| 手动 `workflow_dispatch` + 无 Secret | 跳过 LLM，只跑确定性门禁 |

模型固定为 `deepseek-flash`（DeepSeek V4.1 Flash），`reasoningEffort: max`，不设评审预算上限；若要换模型/端点，改仓库根 `.review/config.json` 的 `model` 段（或等价的 CI env `DEEPSEEK_BASE_URL`）。

## 2. 建议的分支保护

**Settings → Branches → Add branch protection rule**（目标 `main`）：

- [x] Require a pull request before merging
- [x] Require status checks to pass before merging
  - 选择 `Tests + hooks contract + deterministic self-review (node 24)`（ci.yml）
  - 选择 `Deterministic gate + LLM review`（review.yml）
  - 选择 `Git hooks contract (block / pass / skip)`（hooks-contract.yml）
- [x] Require branches to be up to date before merging
- [ ] Do not allow bypassing the above settings（建议勾选，管理员除外）

这样「CI 红 = 不可合并」，评审结论由 `gate.json` 的确定性退出码决定，而不是模型措辞。

## 3. 工作流一览

| 文件 | 触发 | 作用 | 需要 Secret |
|---|---|---|---|
| `ci.yml` | push / PR | `npm test`、git hook 契约测试、`scan --no-llm` 自审 | 否 |
| `review.yml` | PR / 手动 | 确定性门禁 + LLM 评审 + SARIF + 单条幂等 PR 评论 | 是（同仓库 PR 严格模式） |
| `hooks-contract.yml` | push / PR | 真实 `git commit` 验证 pre-commit 阻断/放行/跳过 | 否 |

## 4. 本地验证（可选）

```bash
# 1) 安装真实 git hooks（pre-commit/pre-push）
node bin/review.mjs install-hooks

# 2) 确定性评审（不需要 key）
node bin/review.mjs scan --path . --effort quick --no-llm

# 3) 带模型评审（需要 DEEPSEEK_API_KEY 在环境或 $DSH_HOME/.env）
node bin/review.mjs all --mode range --base origin/main --effort standard

# 4) 读结果
node bin/review.mjs runs
cat .review/runs/<runId>/report.md
```

## 5. 常见问题

- **upload-sarif 报错**：需要仓库可用的 Code Scanning（公开仓库默认可用；私有仓库需要 GHAS），且 workflow 有 `security-events: write` 权限。
- **PR 评论没有更新**：确认 `pull-requests: write` 没被组织/仓库的 Actions 权限策略降级。
- **fork PR 永远看不到 LLM 结论**：这是 GitHub 的安全设计；fork PR 以确定性门禁为准，合并前可在同仓库分支重跑。
- **评审结果为空**：先看 `scope.json` 的排除原因（binary/secret/unsupported_ext/too_large/无 .git 时用 scan 模式），再看 `gate.json`。
