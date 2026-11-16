# lessons — paper-translator

> 已评审：batch-1（`lib/util.js`，quick）与 batch-2（`lib/gateway.js`，standard）。
> 每条 lesson 必须落到具体文件（规则 / prompt / 回归用例 / 项目口径），否则不算沉淀。

## 1. 规则缺口（→ `rules/*.md`）

| # | 现象（来自哪条 finding） | 根因 | 建议新增/修改的规则 | 目标文件 | 验证方式 |
|---|---|---|---|---|---|
| R-1 | `safeName` 未处理 Windows 保留设备名与结尾点/空格 | 通用路径规则没覆盖 Windows 文件名 | 文件与路径节：保留设备名/结尾点号/空格 | `rules/lang-js-ts.md`（已加） | 重跑 deep 确认报出 |
| R-2 | `ensureInside` 用 `path.resolve(相对路径)` 依赖 cwd | 规则没提「相对路径按 cwd 解析」 | 同上节：`path.resolve`≠workspace 根 | `rules/lang-js-ts.md`（已加） | 同上 |
| R-3 | `readJson` catch-all 吞 EACCES/EBUSY/解析错误 | 缺少「区分 ENOENT 与其他错误」判据 | 同上节：catch-all 合并错误类型 | `rules/lang-js-ts.md`（已加） | 同上 |
| R-4 | `writeJson` 就地覆盖没有 tmp+rename | 数据持久化规则缺「原子写」判据 | checkpoint/状态文件必须 tmp+rename 或说明回退理由 | `rules/core-data.md`（下一批补） | batch-3 finding 或 eval |
| R-5 | `gateway.walkImpact` 用 `.catch(() => [])` 吞 readdir 错误 | 规则只覆盖 `catch {}`，没覆盖 promise catch 简写 | 新增 `.catch(() => [])`/`.catch(() => null)` 吞错条目 | `rules/lang-js-ts.md`（已加） | batch-2 复评命中 |
| R-6 | 审批 summary.bytes 取自请求体、决定者身份不校验 | 缺少「审批依据可伪造」判据 | 审批/授权依据来自客户端且不复核 → 报告 | `rules/core-security.md`（已加） | batch-2 复评命中 |
| R-7 | pending 上限 check-then-act、consume 执行前标记 consumed | 规则缺「跨 await 的配额检查」与「一次性授权状态机」 | 新增两条并发/状态机条目 | `rules/core-concurrency.md`（已加） | batch-2 复评命中 |

## 2. prompt 调整（→ `references/prompts.md` + `lib/prompts.mjs`）

| # | 哪个视角/环节 | 要追加的检查项 | 目标文件 | 验证方式 |
|---|---|---|---|---|
| P-1 | 全局 | `human_attention` 无上限，无契约时 11 条泛泛问题把 verdict 顶成 needs-human | `lib/prompts.mjs` BASE_RULES：≤3 条、只保留影响合并/发布的问题 | batch-2 复评 human_attention 明显减少 |
| P-2 | tests | unit 只含被审文件时仍报「本单元没有测试」 | `lib/prompts.mjs` tests 视角禁止范围性观察；`lib/plan.mjs` scan 模式跳过 tests 视角；`lib/aggregate.mjs` 兜底 drop `unit-scope-test-gap` | 重启后重跑 batch-2，eval noise=0 |
| P-3 | 全局 | 无任务契约时 intent 视角仍会报“无法核对意图” | 批次 3 起在 case README 提供最小契约（目标/非目标/验收）再评审 | human_attention 数量下降 |

## 3. 回归用例（→ `findings.json` 基线 + `review eval`）

| # | 缺陷 | 期望行为 | 落点 |
|---|---|---|---|
| E-1…E-6 | batch-1 的 6 条 util 缺陷 | 仍被报出（accepted） | `findings.json` |
| E-7…E-19 | batch-2 的 13 条 gateway 缺陷（accepted） | 仍被报出；允许类别标签/措辞漂移（eval 用同文件近似行/标题相似度匹配） | `findings.json` |
| E-20…E-23 | batch-2 的 4 条 unit-scope 测试缺口 | 不再报出（rejected；tests 视角在 scan 模式应跳过） | `findings.json` |

回归命令：

```bash
node bin/review.mjs eval --repo <paper-translator> --case cases/paper-translator --run latest
# 0=通过；2=召回/精度/过期回归；notEvaluated 表示基线文件不在本次 run 的 scope 内
```

## 4. 逃逸/误报台账

| 批次 | fingerprint（见 findings.json） | 四态 | 原因摘要 | 覆盖 | 后续动作 |
|---|---|---|---|---|---|
| batch-1 | 6 条 | accepted | 见 batch-1 报告 | 规则已补 | 保持基线 |
| batch-2 | 13 条 | accepted | 见 run `run-20261116-193909-9bc6` 报告 | R-5/R-6/R-7 + P-1 | 重启后复评确认 |
| batch-2 | 4 条（tests） | rejected | unit-scope 范围噪声，非真实缺陷 | P-2 + plan scan 跳过 tests + aggregate 兜底 | 重启后 eval 应 noise=0 |

## 5. eval 机制自身的三次修正（meta lesson）

1. **跨批次误报**：batch-2 的 run 只覆盖 gateway.js，batch-1 的 util.js 基线不该判漏报 → eval 按 run scope 过滤，记 `notEvaluated`。
2. **措辞/行号漂移**：同一问题两次运行标题不同、行号移动 → 增加「同文件近似行（±20）+ 中文 bigram 标题相似度」兜底。
3. **类别漂移 vs 类别族**：errors/security/concurrency 允许互认；tests 与代码类别不互认，避免「测试缺口」误配到代码 finding。

## 6. 结论摘要

- 真实缺陷：batch-1 6 条 + batch-2 13 条 accepted（均为 minor；batch-2 复评新增 3 条 major 待下一轮 disposition）。
- 误报：batch-2 4 条 unit-scope 测试噪声（rejected）。
- 新增规则：5 条（R-1/R-2/R-3/R-5/R-6/R-7 已落，R-4 待落 core-data）。
- prompt 调整：2 处（P-1/P-2 已落）。
- 回归用例：19 accepted + 4 rejected。
- 产品改进：见 case README 表格（verdict 语义、report 结论、插件输出清洗、repo 参数、scan lenses、eval 匹配、规则）。
