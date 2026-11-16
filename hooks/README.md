# Git hooks（客户端快速门禁）

本目录仓库级的 git hooks 由 dsh-code-reviewer 提供并安装。它们**只是客户端的「快速网」**：
拦截明显问题、减少往返；**权威（authoritative）门禁是 GitHub Actions**（`.github/workflows/review.yml`
的 LLM 评审 + 确定性 gate + SARIF + PR 评论）。任何本地 hook 都可以被有意绕过，CI 不会。

```
.githooks/
├── pre-commit   # 暂存区（staged）确定性检查：scope --mode staged + gate.commands，不调 LLM
└── pre-push     # 相对 upstream 的 range 检查：fast=确定性，full=含 LLM 完整评审
```

## 安装 / 卸载

```sh
# 安装：写 .githooks/pre-commit、.githooks/pre-push，并设置 core.hooksPath=.githooks
node bin/review.mjs install-hooks

# 只对某个仓库安装（默认是当前工作目录）
node bin/review.mjs install-hooks --repo /path/to/repo

# 卸载：恢复 git 默认 hooks 路径（删除 core.hooksPath 配置，保留 .githooks/ 文件）
node bin/review.mjs install-hooks --uninstall
```

安装后等价于：

```sh
git config core.hooksPath .githooks
```

如果 `.githooks/` 是随仓库提交的（本身已包含两个 hook），也可以手动执行上面这条
`git config` 命令，效果相同。

## 模式：off / fast / full

在仓库的 `.review/config.json` 中配置（全部可选，默认 `fast`）：

```json
{
  "hooks": { "preCommit": "fast", "prePush": "fast", "enabled": true }
}
```

| 模式 | 行为 | 何时用 |
| --- | --- | --- |
| `off` | 直接放行，不执行任何检查 | 临时关闭 |
| `fast` | **确定性**：scope + rules/plan + `gate.commands`/autodetect 门禁；**不调 LLM**，秒级 | 默认；日常提交/推送 |
| `full` | 含 LLM 的完整评审（`review run` + gate），耗时取决于 diff 大小与模型 | 重要分支推送前 |

- `pre-commit`：只对**暂存区**（staged）做 fast 检查；有阻断结论才非零退出。
- `pre-push`：对 `@{upstream}`（失败则回退 `main`）的 range 做检查；默认 fast，可设 `full`。
- gate 命令来自 `.review/config.json` 的 `gate.commands`；为空时按 lint / typecheck / test
  自动探测。退出码：`0` 通过、`2` 阻断、`3` needs-human、`4` 必需命令失败、`5` 引擎错误。

## 跳过 hook

```sh
# 所有 hook 统一跳过（工具内部识别，打印一行提示后放行）
REVIEW_SKIP_HOOKS=1 git commit -m "wip"
REVIEW_SKIP_HOOKS=1 git push

# git 原生跳过（等价于一次性绕过，不依赖工具实现）
git commit --no-verify -m "wip"
git push --no-verify
```

> 跳过只影响本地。**不要把绕过本地 hook 当作放行依据**：PR 上的 GitHub Actions 仍然会跑
> 确定性 gate 与 LLM 评审，并以 `gate.json` 的退出码判断。

## Windows 说明

- Windows 只安装了 **Git for Windows** 即可，不需要 WSL：其自带的 bash（`usr/bin/bash`）
  会按 shebang `#!/bin/sh` 执行 hooks。
- hook 要求 `node` 在 `PATH` 上（Git Bash 继承 Windows `PATH`）；找不到 node 时 hook
  打印提示并放行（不误伤提交）。
- Windows 上 git 不记录可执行位（`core.fileMode=false`），hook 文件内容就够用；
  **在 Linux/macOS 上** git 要求 hook 可执行：`install-hooks` 会设置 `0755`，若你手动
  设置 `core.hooksPath` 则需 `chmod +x .githooks/pre-commit .githooks/pre-push`。
- 仓库路径包含空格无需额外处理：hook 内部用 `"$ROOT"` 引用路径。

## 产物与排错

- 每次运行都落盘到 `.review/runs/<runId>/`（`.review/` 已 gitignore）：
  `scope.json`、`plan.json`、`gate.json`、`report.md|json|sarif`。
- 先看 `gate.json`：`checks[]` 里每条的 `cmd`/`exit`/`durationMs`/`stdoutTail` 是确定性的判断依据。
- hook 输出异常时：`REVIEW_SKIP_HOOKS=1` 先绕过提交，然后单独执行
  `node bin/review.mjs hook pre-commit` 复现。
- `node test/hooks.contract.mjs`（CI：`.github/workflows/hooks-contract.yml`）会用真实
  `git commit` 验证「gate 失败 → hook 阻断」「gate 通过 → 放行」「REVIEW_SKIP_HOOKS=1 → 放行」
  这三条契约。
