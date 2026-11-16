# 报告规范：md / json / sarif、行内评论、needs-human、成本

三种产物由同一次 `review report` 写出（`writeReports`），内容同源：

```bash
node bin/review.mjs report --run <runId|latest>                    # 写 run 目录下三种格式
node bin/review.mjs report --run <runId> --format md --out PR.md   # 指定格式并复制到指定路径
```

`--run latest` 解析最近一次 run；CI 用它把产物复制到 `.review-ci/`。

## 1. `report.md`（人读，贴 PR / 交付说明）

固定结构，缺节视为报告不完整：

```text
# 评审报告
- runId / 范围模式 / 评审强度 / 轮次 / 模型
- 结论：通过 / 阻断（必须修复） / 需人工判断
## 统计
| blocker | major | minor | needsHuman | dropped |
## 门禁
verdict + exitCode + 阻断项数量；checks 表（cmd / exit / 耗时 / stdoutTail）
## 阻断项（blocker / major）
- `file:startLine-endLine` [severity/category/votes]
  problem / evidence / impact / suggestion
## 需人工（needs-human）
- 原因：未锚定 / 证据不足 / 视角分歧 / 解析失败 / out-of-scope；需要人回答什么
## 既有问题（preexisting，不阻塞）
## 覆盖率
每个文件 reviewed 或 skipped(原因)；coverage.complete / unreviewed
## 成本
调用次数、input/output/cache tokens、耗时、开始/结束、模型
## 产物
report.json / report.sarif 路径
```

## 2. `report.json`（机器读）

`schemaVersion: 1`，顶层字段（`lib/report.mjs` 产出）：

| 字段 | 内容 |
|---|---|
| `runId` / `generatedAt` / `tool{name,version}` | 标识与版本 |
| `mode` / `effort` / `rounds` / `model` | 本次运行参数 |
| `usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` / `calls` / `durationMs` / `startedAt` / `finishedAt` | 成本与耗时 |
| `scope` / `plan` | 直传产物（含 coverage、units、skippedFiles） |
| `aggregate` | `{findings, counts{blocker,major,minor,needsHuman,dropped}, verdict, blocking, humanAttention, errors}` |
| `gate` | 与 `gate.json` 一致（checks/verdict/exitCode），不二次加工 |
| `meta` / `artifacts` | 运行元数据与三种报告路径 |

- **findings 在 `aggregate.findings`**（不是顶层）：finding schema v1——`fingerprint`、`file`、`startLine`、`endLine`、`line`、`hunkId`、`anchorReason`、`anchored`、`category`、`severity`、`title`（=problem）、`problem`、`evidence`、`impact`、`suggestion`、`existing_code`、`preexisting`、`votes`、`lenses[]`、`unitIds`、`status`（real|needs-human|dropped）、`blocking`；dropped 项另有 `dropReason`。
- 消费方以 `schemaVersion` 分支；新增字段只加不改名。

## 3. `report.sarif`（code scanning）

- SARIF 2.1.0；`runs[0].tool.driver.name = "dsh-code-reviewer"`；`ruleId = dsh-<category>`。
- 结果：`artifactLocation.uri` 用仓库相对 POSIX 路径（不带盘符）+ `region.startLine`（有结束行才给 `endLine`）。
- 只写 `anchored=true`、`startLine>0` 且 `status != dropped` 的 finding；未锚定项只在 md 的 needs-human 区出现。
- `level`：blocker→`error`、major→`warning`、minor→`note`；`partialFingerprints.dshFingerprint` 便携去重；`properties` 带 severity/category/status/votes/lenses/preexisting/blocking/fingerprint。

## 4. 行内评论定位规则

1. 只对 `anchored=true` 的 blocker/major 发 PR 行内评论；minor 不进评论（进总结）。
2. 定位来源：`existing_code` 在该文件新内容中滑窗匹配（±40 行、允许 trim 空白）→ `startLine/endLine`；失败时用 `line` 夹到 diff 新行集合；再失败 → `anchored=false`。
3. 行号一律指**新文件行号**；`endLine >= startLine`；同一文件同一行多条合并为一条评论。
4. 不锚定的 finding 不发行内评论，只在总结评论的 needs-human 区列出，并请求人工定位。
5. 禁止为凑定位修改 `existing_code`、编造行号或使用旧文件行号。

## 5. needs-human 区（不许省略）

每条至少包含：finding fingerprint、位置（或「未锚定」）、原因类别、问题描述、**需要人回答的具体问题**、处置（人工确认 / 转 issue / 补证据后重审 / 接受风险）。

- needs-human 不能当 blocker 压作者，也不能静默丢弃；报告里必须出现。
- 处置结果回写 `cases/<repo>/dispositions.json`，供 `review eval` 回归。

## 6. 成本统计（无预算上限 ≠ 不看成本）

- 必须回报：input/output/cache read/cache write tokens、调用次数、墙钟耗时、模型名、effort、轮次。
- 写入 `report.md`「成本」节与 `report.json` 顶层 `usage`/`calls`/`durationMs`；`review --json` 的 stdout 也带 usage。
- 单次评审 token/耗时异常（明显高于同类 diff）→ 记入 `cases/<repo>/lessons.md`，作为范围/打包/规则优化输入。
- 令牌与 API key 绝不写入报告、日志或 artifact。

## 7. 一致性检查（提交前）

- `gate.json.exitCode`、`report.md` 结论、`review --json` 的 `exitCode` 三者一致。
- 评论里的阻断项数量 = `aggregate.counts.blocker + counts.major`（按 `blockOn` 口径）。
- SARIF 结果数 ≤ `aggregate.findings` 中 `anchored=true` 的数量；不相等说明定位/过滤有 bug。
