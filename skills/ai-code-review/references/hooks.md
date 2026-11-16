# git hooks：职责边界、fast/full、逃生口

hooks 是**本地快反馈**，不是权威门禁：真正的阻断在 CI/远端 branch protection。hook 可以被跳过，所以它只负责「别把明显坏的提交推出去」。

## 1. 职责边界

| hook | fast（默认） | full |
|---|---|---|
| `pre-commit` | 只跑 `.review/config.json` 的 `gate.commands`（**autodetect 关闭、不调 LLM**）；有失败才非零退出；不写评审 run | 委托 CLI `review all --mode staged`：scope→plan→LLM→gate→report（分钟级 + token 成本，不建议） |
| `pre-push` | 对 push range 跑确定性 gate（`gate.commands` + autodetect；不调 LLM） | 委托 CLI `review all --mode range --base <upstream>`：完整 LLM 评审 + gate + report |

- `fast` 是为了秒级反馈；它**不产生** `scope.json`/`report.*` 等评审产物（只有 gate 结果）。
- `full` 是子进程调用 CLI，产物落在 `.review/runs/<runId>/`；代价高，只在重要分支手动使用。
- `pre-push` 的 base 默认 `@{upstream}`，解析不到时回退 `main`。

## 2. 安装 / 卸载

```bash
node bin/review.mjs install-hooks [--repo <dir>]      # 写 .githooks/pre-commit、.githooks/pre-push + core.hooksPath
node bin/review.mjs install-hooks --uninstall          # 删除 core.hooksPath 配置，保留 .githooks 文件
```

- 生成的 hook 是 `#!/bin/sh`，把**工具 checkout 的绝对路径**写进 `ROOT`，执行 `node "$ROOT/bin/review.mjs" hook <name> || exit $?`。
- 因此：移动/删除工具目录会让 hook 失效；重装会覆盖 `.githooks/` 里的生成内容，不要手改。
- 安装会设置 `git config core.hooksPath .githooks`；检查：`git config --get core.hooksPath` 输出 `.githooks`。
- `node` 不在 PATH 时 hook 直接放行（`command -v node ... || exit 0`），避免误伤提交；这也是 hook 不可当作权威门禁的原因之一。
- 团队共享：把 `.githooks/` 提交进仓库，每人执行一次 `install-hooks`（不要提交 `core.hooksPath` 配置）。
- POSIX 上 hook 需要可执行位（install 会 chmod 0755）；手工设置 `core.hooksPath` 时需 `chmod +x`。

## 3. fast / full 配置

`hooks.preCommit` / `hooks.prePush` 取值 `off|fast|full`，默认 `fast`（`hooks.enabled=false` 等价全部 off）：

```json
{ "hooks": { "preCommit": "fast", "prePush": "fast", "enabled": true } }
```

| 模式 | 行为 |
|---|---|
| `off` | 直接放行，不执行检查 |
| `fast` | 确定性 gate（不调 LLM）；pre-commit 只跑配置命令，pre-push 允许 autodetect |
| `full` | 子进程 `review all`（含 LLM）；pre-commit 用 `--mode staged`，pre-push 用 `--mode range --base <upstream>` |

> 契约 §7 描述的「pre-commit scope→plan→gate（不调 LLM）」对应默认 `fast` 的确定性语义；`full` 是显式打开的完整流程，不应作为 pre-commit 默认。以 `lib/hooks.mjs` 与 `hooks/README.md` 为准。

## 4. 逃生口 `REVIEW_SKIP_HOOKS=1`

```powershell
$env:REVIEW_SKIP_HOOKS = "1"; git commit -m "..."
```

- 行为：写一行日志后 `exit 0`，不执行任何检查（对所有 hook 生效）。
- 只用于：紧急止血、工具自身故障、hook 确认为误报。**不许**用于常规开发，**不许**在 CI 里设置。
- 使用后必须在 PR 描述/交付说明写明「本次跳过本地 hook，原因 X」；CI 仍会跑权威门禁。
- 等价的手工绕过：`git commit --no-verify` / `git push --no-verify`（不依赖本工具实现）。

## 5. 不要做的事（代价与反模式）

- **不要在 pre-commit 跑全量 LLM 评审**（即不要设 `preCommit: full`）：每次 commit 分钟级等待 + token 成本；开发者会习惯性 `--no-verify`，等于门禁失效。LLM 评审放 pre-push full、手动或 CI。
- 不要在 hook 里跑慢测试/构建：超过 ~10s 的检查留给 CI；hook 只跑 lint/type/快测。
- 不要在 hook 里执行 `git add`/格式化并提交：会混入非预期改动，破坏「一次一个目的」。
- 不要依赖网络（无网/内网会卡死 commit）；LLM 调用失败要快速失败或明确提示。
- 不要把 hook 当权威门禁：hook 可被 `--no-verify`、`REVIEW_SKIP_HOOKS=1`、未安装 hook、node 缺失绕过。

## 6. 用 CI 验证 hook 契约（防回归）

- 契约测试：`node test/hooks.contract.mjs`（standalone 脚本，不是 `node:test` 文件）——临时 repo + `install-hooks`：
  - `gate.commands` 配置 `node -e "process.exit(1)"` 时 `git commit` 必须失败；
  - 配置 `exit 0)` 时重试提交必须成功；
  - `REVIEW_SKIP_HOOKS=1` 时必须放行。
- CI：`.github/workflows/hooks-contract.yml` 在每次 push/PR 跑上面这条，防止 hook 静默失效（hook 失效是「假绿」的常见来源）。
- 手工验收（改 hook 逻辑后）：
  ```bash
  node bin/review.mjs install-hooks
  git commit --allow-empty -m "hook smoke"                  # 有 blocking gate 时应失败
  REVIEW_SKIP_HOOKS=1 git commit --allow-empty -m "bypass"   # 应放行
  ```
- 验收要看退出码与 stderr，而不只是「有没有输出」：hook 必须把失败原因指向具体 check/finding。
