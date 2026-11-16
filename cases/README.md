# cases/ — 经验飞轮：样例仓库与判定归档

每个目录是一个**真实样例仓库**的一次评审归档。作用不是展示报告，而是回答三个问题：

1. 这次评审抓到了哪些真实缺陷（`accepted`/`fixed`）？
2. 报错了哪些（`rejected`/`ignored`）？误报是过滤、规则还是 prompt 的问题？
3. 规则/prompt 缺了什么（`lessons.md` 必须落到具体文件）？

**硬约定**：任何 `rules/*.md` 或 `lib/prompts.mjs` 的改动，都必须能追溯到某个 case 的 `lessons.md`（见 `CONTRACT.md` §11）。

## 目录结构

```text
cases/<repo>/
├── README.md          # 评审范围、仓库形态、当前状态、要回答的问题
├── findings.json      # 该次评审产出（从 .review/runs/<runId>/aggregate.json 的 findings 导出，禁止手造）
├── dispositions.json  # 人对每条 finding 的判定（本文件 schema 见下）
└── lessons.md         # 规则缺口 / prompt 调整 / 回归用例，注明落点文件
```

## dispositions schema（v1）

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
      "title": "一句话标题",
      "disposition": "accepted",
      "reason": "为什么这样判定；accepted 给复现，rejected 给反证",
      "date": "2026-11-16",
      "ref": "commit:<sha> | issue:#12 | pr:#34",
      "target": "rules/<rule-id>.md | references/prompts.md | REVIEW.md"
    }
  ]
}
```

字段约束：
- `disposition` 只能是 `accepted | rejected | ignored | fixed` 四态之一；
- `reason`、`date` 必填；`rejected` 必须有可验证反证；`ignored` 必须写风险接受人 + 后续 issue；`fixed` 必须给 `ref`；
- `fingerprint/file/startLine/severity` 来自 `findings.json`，不要手改，防止对不上账；
- 没有 findings 的 case 保留空数组：`"dispositions": []`。

## 四态含义

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `accepted` | 真实缺陷，需要修 | 修复后改 `fixed` 并填 `ref` |
| `rejected` | 误报，评审器判断错误 | 据此改 filter/规则/prompt，并留反证 |
| `ignored` | 真实但本次不处理 | 记录风险接受人与后续 issue |
| `fixed` | 已修复 | 填 commit/PR，并补回归依据 |

## 当前样例

| case | 仓库形态 | 评审模式 | 状态 |
|---|---|---|---|
| [`paper-translator/`](paper-translator/README.md) | DSH 插件（无 `.git`） | `review scan` | 待评审 |

## 使用方式

```bash
# 对某个 case 的仓库跑评审（scan 模式）
node bin/review.mjs scan --path <case 仓库路径> --effort deep --json

# 用判定结果做回归
node bin/review.mjs eval --case cases/<repo> --json
```

规则与 prompt 改动流程：改实现 → 跑对应 case `eval` → 跑全仓自审 → 在 PR 里引用 case 路径与 `lessons.md` 条目。

## 禁止

- 编造 findings / dispositions 凑数量；
- `findings.json` 手工编辑（它是工具产出，改了就无法回归）；
- lessons 没有落点文件；
- 把 case 当模型排行榜/性能基准（那是独立评测，需要单独标注口径）。
