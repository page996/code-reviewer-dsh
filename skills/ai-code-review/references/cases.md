# 经验飞轮（cases/）：让每个逃逸缺陷变成资产

没有沉淀，同类缺陷会反复出现。本仓库约定：**任何规则或 prompt 改动都必须能追溯到某个 case**（`CONTRACT.md` §11）。

## 1. 目录与职责

```text
cases/<repo>/
├── README.md          # 评审范围、仓库形态、当前状态、要回答的问题
├── findings.json      # 该次评审的真实产出（从 run 的 aggregate.json.findings 导出，不手改）
├── dispositions.json  # 人对每条 finding 的判定（accepted/rejected/ignored/fixed）
└── lessons.md         # 提炼的规则缺口/prompt 调整/回归用例，注明落到哪个文件
```

`<repo>` 用仓库目录名（如 `paper-translator`），一个样例仓库一个目录；不要按 runId 建目录。

## 2. dispositions schema（四态）

```json
{
  "schemaVersion": 1,
  "dispositions": [
    {
      "fingerprint": "sha1:...",
      "file": "lib/llm.js",
      "startLine": 120,
      "endLine": 128,
      "category": "errors",
      "severity": "major",
      "title": "重试耗尽后仍返回部分结果",
      "disposition": "accepted",
      "reason": "确认真实：超时路径会把空 batch 当成功；由 lib/llm.js 复现",
      "date": "2026-11-16",
      "ref": "commit:abc1234 | issue:#12 | pr:#34",
      "target": "rules/llm-retry.md"
    }
  ]
}
```

| disposition | 含义 | 后续动作 |
|---|---|---|
| `accepted` | 真实缺陷，需要修 | 修复后改 `fixed` 并填 `ref` |
| `rejected` | 误报（评审器判断错误） | 必须给反证；据此改 filter/规则/prompt |
| `ignored` | 真实但本次不处理 | 写风险接受人 + 后续 issue；不许只写「暂不修」 |
| `fixed` | 已修复 | 必须填 `ref`（commit/PR），并补回归依据 |

规则：每条必须有 `reason` 与 `date`；`rejected` 必须有可验证的反证；`ignored` 必须有责任人；禁止编造 finding（`findings.json` 只能来自工具产出）。

## 3. lessons：每条必须落到具体文件

| 类型 | 落点（具体文件） | 示例 |
|---|---|---|
| 规则缺口 | `rules/<rule-id>.md`（frontmatter：`id`、`title`、`paths`/glob、`severityHint`、`alwaysApply`） | 新增 `win-path.md` 覆盖 Windows 路径 |
| prompt 调整 | `references/prompts.md` + `lib/prompts.mjs`（两处同步） | `tests` 视角追加「断言能否失败」 |
| 回归用例 | 本 case 的 `findings.json` 基线 + `review eval` | 已知缺陷下次仍被报出 |
| 评审口径 | 目标仓库的 `REVIEW.md` / `AGENTS.md` | 新增重点路径与常见失败模式 |
| 门禁覆盖 | `.review/config.json` 的 `gate.commands` | 补一条针对性测试命令 |

`lessons.md` 每条写成可执行的一句话（改哪个文件、加什么），不要写「加强评审」「注意边界」这类无法验收的结论。

## 4. 用 `review eval` 回归

```bash
node bin/review.mjs eval --case cases/<repo> --json
```

- 基线 = 本 case 的 `findings.json`（产出）+ `dispositions.json`（判定）。
- 回归失败口径：`accepted`/`fixed` 的缺陷不再被报出（漏报）；`rejected`/`ignored` 的问题再次以 blocker/major 出现（噪音回归）；counts 与基线明显劣化。
- 需要 LLM 的 case 在无 key 时只能验证确定性规则部分，必须标注「部分回归」，不能当全绿。
- 规则/prompt 改动后先跑对应 case，再跑全仓自审（`review scan`），二者都过才提交规则变更。

## 5. 新增 case 流程

1. 选一个有真实缺陷或真实误报的仓库（有 `.git` 用 `review all/range`，无 `.git` 用 `review scan`）。
2. 跑评审，`findings.json` 从 run 的 `aggregate.json.findings` 导出，不手工编辑。
3. 人逐条填 `dispositions.json`（四态 + 原因 + ref）。
4. 从 dispositions 提炼 `lessons.md`，每条绑定落点文件。
5. 改规则/prompt，跑 `review eval --case` 回归，再在 PR 里引用 case 路径。
6. 更新 case `README.md` 的「当前状态」（待评审 / 已评审 / 已回归 / 已关闭）。

## 6. 禁止

- 编造 findings 或 dispositions 凑数量；
- 只写「已修复」不给 commit/PR 引用；
- lesson 没有落点文件（等于没沉淀）；
- 规则/prompt 改了却不附 case（下次无法解释为什么改）；
- 把 case 当性能基准或模型评测集用（那是另一套评测，需要独立标注）。
