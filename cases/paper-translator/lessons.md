# lessons — paper-translator

> 批次 1（`lib/util.js`，run `run-20261116-190955-746b`）已完成并逐条判定。
> 每条 lesson 必须落到具体文件（规则 / prompt / 回归用例 / 项目口径），否则不算沉淀。

## 1. 规则缺口（→ `rules/*.md`）

| # | 现象（来自哪条 finding） | 根因 | 建议新增/修改的规则 | 目标文件 | 验证方式 |
|---|---|---|---|---|---|
| R-1 | `safeName` 未处理 Windows 保留设备名与结尾点/空格（finding #6 的 human_attention 分支） | 通用「路径安全」规则只写了 traversal，没覆盖 Windows 文件名 | 新增「文件与路径」节：保留设备名/结尾点号/空格 | `rules/lang-js-ts.md`（已加） | 重跑 deep，确认 Windows 文件名类问题被报出 |
| R-2 | `ensureInside` 用 `path.resolve(相对路径)` 依赖 cwd | 规则没提“相对路径按 cwd 解析”这一陷阱 | 同上节：`path.resolve`≠workspace 根 | `rules/lang-js-ts.md`（已加） | 同上 |
| R-3 | `readJson` catch-all 吞 EACCES/EBUSY/解析错误 | 规则没有“区分 ENOENT 与其他错误”的可判定条件 | 同上节：catch-all 合并错误类型 → 静默丢状态 | `rules/lang-js-ts.md`（已加） | 同上 |
| R-4 | `writeJson` 就地覆盖没有 tmp+rename | 数据持久化规则缺“原子写”判据 | `rules/core-data.md` 后续补「checkpoint/状态文件必须 tmp+rename，或说明回退理由」 | `rules/core-data.md`（下一批） | 下一批 finding 或 eval |

## 2. prompt 调整（→ `references/prompts.md` + `lib/prompts.mjs`）

| # | 哪个视角漏了 | 要追加的检查项 | 目标文件 | 验证方式 |
|---|---|---|---|---|
| P-1 | 全局 | `human_attention` 无上限，无任务契约时输出 11 条泛泛问题，把 verdict 顶成 needs-human | `lib/prompts.mjs` BASE_RULES（已加：≤3 条、只保留影响合并/发布的问题）+ `skills/ai-code-review/references/prompts.md` | 重跑 quick，human_attention ≤3 且 verdict 不被顶掉 |
| P-2 | intent | 无任务契约时无法核对“改动意图”，容易泛化提问 | 批次 2 起在 case README 提供最小契约（目标/非目标/验收）再评审 | 重跑一批，human_attention 数量下降 |

## 3. 需要新增的回归用例（→ 本 case 基线 + `review eval`）

| # | 缺陷/误报 | 输入（文件/片段） | 期望行为 | 落点 |
|---|---|---|---|---|
| E-1 | 单行超长不切分 | `lib/util.js` `splitIntoChunks` | 下次仍被报出（`accepted`） | `findings.json` 基线 |
| E-2 | catch-all 读错误 | `lib/util.js` `readJson` | 仍被报出（`accepted`） | 同上 |
| E-3 | 非原子写 + 静默回退 | `lib/util.js` `writeJson` | 仍被报出（`accepted`） | 同上 |
| E-4 | 字面路径校验不解析 symlink | `lib/util.js` `ensureInside` | 仍被报出（`accepted`） | 同上 |
| E-5 | 取首个括号当 JSON | `lib/util.js` `jsonFromModel` | 仍被报出（`accepted`） | 同上 |
| E-6 | `mapLimit(limit<=0)` 空洞数组 | `lib/util.js` `mapLimit` | 仍被报出（`accepted`） | 同上 |

回归命令：

```bash
node bin/review.mjs eval --case cases/paper-translator --run latest
# 有回归 exit 2；accepted 漏报 / rejected|fixed 复现 都会失败
```

## 4. 逃逸/误报台账

| finding fingerprint | 四态 | 原因摘要 | 是否已有规则/prompt 覆盖 | 后续动作 |
|---|---|---|---|---|
| `31cf332029bf4617d6410c766da1d3eedcab6f8a` | accepted | 单行超长不切分，长中文段落会超上下文 | 是（core-correctness 边界） | 保持基线 |
| `bab600de985f9714aa3c25d4bd99fed65a16701e` | accepted | catch-all 吞 EACCES/EBUSY/parse | 是（R-3） | 保持基线 |
| `82ee4915a946e329a7c3d37b7e0d70676f7c70c7` | accepted | 就地写 + catch-all 读回 = 静默丢 checkpoint | 是（R-4 待补） | 下一批补 core-data 规则 |
| （ensureInside symlink） | accepted | 字面路径校验可通过根内外链 | 是（R-2/R-4） | 调用点批次复查 |
| （jsonFromModel 首括号） | accepted | 正文先出括号时误判 JSON 起点 | 是（core-errors） | 保持基线 |
| （mapLimit limit<=0） | accepted | 空洞数组、operation 未执行 | 是（core-concurrency） | 保持基线 |

> 精确 fingerprint 以 `cases/paper-translator/findings.json` 为准；本表里带简称的行在后续批次补齐 fingerprint。

## 5. 结论摘要

- 真实缺陷：6 条（blocker 0 / major 0 / minor 6）；全部 accepted。
- 误报：0 条（本批未出现可证伪 finding；产品侧修复了 11 条 human_attention 噪声）。
- 新增规则：3 条（R-1/R-2/R-3 已落 `rules/lang-js-ts.md`），R-4 待落 `rules/core-data.md`。
- prompt 调整：1 处（P-1，已落 `lib/prompts.mjs`）。
- 回归用例：6 条（E-1…E-6）。
- 产品改进：verdict 与 gate 语义解耦、report 结论以 gate 为准、插件输出 schema 清洗（见 `README.md`）。
- 是否更新 `REVIEW.md`/`AGENTS.md`：否（本仓库无 .git，也不属于被评审项目的改造范围）。
