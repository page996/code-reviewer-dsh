# lessons — paper-translator（评审后填写）

> 本文件只在**评审完成并逐条判定 dispositions 之后**填写。每条 lesson 必须落到具体文件（规则 / prompt / 回归用例 / 项目口径），否则不算沉淀。
> 当前状态：**待评审**（`findings.json` 未生成，`dispositions.json` 为空）。

## 1. 规则缺口（→ `rules/*.md`）

| # | 现象（来自哪条 finding） | 根因 | 建议新增/修改的规则 | 目标文件 | 验证方式 |
|---|---|---|---|---|---|
| R-1 | （待填） | （待填） | （待填） | `rules/<rule-id>.md` | `review eval --case cases/paper-translator` |
| R-2 | | | | | |

> 新规则 frontmatter 至少写清 `id`、`title`、`paths`（glob）、`severityHint`、`alwaysApply`；规则正文写成「如果…那么…」的可判定条件。

## 2. prompt 调整（→ `references/prompts.md` + `lib/prompts.mjs`）

| # | 哪个视角漏了 | 要追加的检查项 | 目标文件 | 验证方式 |
|---|---|---|---|---|
| P-1 | （待填） | （待填） | `references/prompts.md` §2 + `lib/prompts.mjs` | 重跑 deep，确认该缺陷被报出 |
| P-2 | | | | |

> prompt 两处必须同步改（文档 + 实现），只改一处视为未完成。

## 3. 需要新增的回归用例（→ 本 case 基线 + `review eval`）

| # | 缺陷/误报 | 输入（文件/片段） | 期望行为 | 落点 |
|---|---|---|---|---|
| E-1 | （待填） | （待填） | 下次仍被报出（`accepted`/`fixed`） | `findings.json` 基线 |
| E-2 | （待填） | （待填） | 不再以 blocker/major 出现（`rejected`/`ignored`） | 同上 |

## 4. 逃逸/误报台账

| finding fingerprint | 四态 | 原因摘要 | 是否已有规则/prompt 覆盖 | 后续动作 |
|---|---|---|---|---|
| （待填） | accepted/rejected/ignored/fixed | | 是/否 | |

## 5. 结论摘要（评审后填）

- 真实缺陷：N 条（blocker / major / minor）
- 误报：N 条（过滤 / 规则 / prompt 归因）
- 新增规则：N 条；prompt 调整：N 处；回归用例：N 条
- 是否更新 `REVIEW.md` / `AGENTS.md`：是/否，改了哪一节
