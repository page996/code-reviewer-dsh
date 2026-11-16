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
| R-8 | batch-3 真实运行出现一次 `DeepSeek Messages transport failed`，单次传输失败直接让一个视角丢结果、verdict 变 needs-human | 评审编排只在 schema 错误时重试，没有对传输/供应商瞬时错误重试 | reviewer 调用内对 `LLM/TRANSPORT/LLM_SERVER/LLM_RATE_LIMIT/LLM_TIMEOUT` 重试（最多 3 次、退避），仍失败才记录 error | `lib/review.mjs`（已加） | 单测覆盖 + batch-3 重跑 14 findings |
| R-9 | batch-2 多次复评结果数量在 12–20 之间波动，case 回归出现假漏报 | reviewer 未固定 temperature，采样导致同一输入输出漂移 | `review.temperature` 默认 0，可按部署覆盖 | `lib/review.mjs` + `lib/config.mjs`（已加） | 重启后连续两次 batch-2 复评结果一致 |
| R-10 | batch-4：per-process token 允许 URL query 传递且被写进页面；鉴权回退依赖客户端可伪造的 `Sec-Fetch-Site`/`Host` | 安全规则缺「令牌泄漏面」与「伪造头回退即绕过」判据 | 新增令牌泄漏/鉴权回退条目 | `rules/core-security.md`（已加） | batch-4 真实命中 |
| R-11 | batch-4：job 已 completed 后收尾抛错改判 failed；服务端故障被映射成 400；流式响应读流无 error 处理 | 错误处理规则缺「终态不可改写 / 错误分类 / 流错误」 | 新增三条错误处理条目 | `rules/core-errors.md`（已加） | batch-4 真实命中 |
| R-12 | batch-4：未知 docId 返回 400 而非 404；契约检查崩溃降级对象缺字段 | 契约规则缺「状态码/响应形状稳定性」判据 | 新增契约高频问题清单 | `rules/core-contract.md`（已加） | batch-4 真实命中 |
| R-13 | batch-5：scan 模式 2 条 major 把 `gate` 判成 block/exit 2 | scan 无 diff，finding 本应全部 preexisting；实现只信 reviewer 的 preexisting 字段 | scan findings 标 preexisting + gate 对 scan 忽略 blocking（`blockPreexisting` 可覆盖） | `lib/review.mjs` + `lib/gate.mjs` + CONTRACT §3（已加） | 单测 + batch-5 gate 恢复 pass |
| R-14 | batch-6（Python）：页面几何未钳制导致无界数组/逐点累加；解析异常被吞；`not is_multi` 分支死代码；混排打平破坏栏带 | Python 规则包缺「不可信几何/解析吞错/死代码/混排」判据 | 新增 Python 高频条目 | `rules/lang-python.md`（已加） | batch-6 真实命中 |

## 2. prompt 调整（→ `references/prompts.md` + `lib/prompts.mjs`）

| # | 哪个视角/环节 | 要追加的检查项 | 目标文件 | 验证方式 |
|---|---|---|---|---|
| P-1 | 全局 | `human_attention` 无上限，无契约时 11 条泛泛问题把 verdict 顶成 needs-human | `lib/prompts.mjs` BASE_RULES：≤3 条、只保留影响合并/发布的问题 | batch-2 复评 human_attention 明显减少 |
| P-2 | tests | unit 只含被审文件时仍报「本单元没有测试」 | `lib/prompts.mjs` tests 视角禁止范围性观察；`lib/plan.mjs` scan 模式跳过 tests 视角；`lib/aggregate.mjs` 兜底 drop `unit-scope-test-gap` | 重启后重跑 batch-2，eval noise=0 |
| P-3 | 全局 | 无任务契约时 intent 视角仍会报“无法核对意图” | 批次 3 起在 case README 提供最小契约（目标/非目标/验收）再评审 | human_attention 数量下降 |
| P-4 | tests | PR 自评审（GitHub Actions 真实跑）对测试代码报「判别力不足/断言可以更强」这类纯增强建议（3 条 minor） | `lib/prompts.mjs` tests 视角：只报会掩盖真实回归的测试缺陷（断言与实现矛盾、必然误通过、删弱/跳过断言、mock 掩盖真实调用），不报增强建议 | 下次 PR 评审中 tests 类 minor 减少 |

## 3. 回归用例（→ `findings.json` 基线 + `review eval`）

| # | 缺陷 | 期望行为 | 落点 |
|---|---|---|---|
| E-1…E-6 | batch-1 的 6 条 util 缺陷 | 仍被报出（accepted） | `findings.json` |
| E-7…E-19 | batch-2 的 13 条 gateway 缺陷（accepted） | 仍被报出；允许类别标签/措辞漂移（eval 用同文件近似行/标题相似度匹配） | `findings.json` |
| E-20…E-23 | batch-2 的 4 条 unit-scope 测试缺口 | 不再报出（rejected；tests 视角在 scan 模式应跳过） | `findings.json` |
| E-24…E-37 | batch-3 的 14 条 pipeline 缺陷（accepted） | 仍被报出；batch-3 run 的 eval 已达到 matched 14 / missed 0 / noise 0 | `findings.json` |
| E-38…E-56 | batch-4 的 19 条 index.js 缺陷（accepted） | 仍被报出；batch-4 run 的 eval：matched 19 / missed 0 / noise 0 | `findings.json` |
| E-57…E-68 | batch-5 的 12 条 library.js 缺陷（含 2 条 major，accepted） | 仍被报出；batch-5 run 的 eval：matched 12 / missed 0 / noise 0 | `findings.json` |
| E-69…E-76 | batch-6 的 8 条 pageparse.py 缺陷（accepted） | 仍被报出；batch-6 run 的 eval：matched 8 / missed 0 / noise 0 | `findings.json` |

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
| batch-3 | 14 条 | accepted | 安全（--no-sandbox + 不可信 HTML）、QA 六检查共用 try/catch、视觉探测吞错、页码映射、未翻译率缺失字段、临时文件异常路径泄漏等 | R-6/R-3 部分覆盖；`lib/pipeline.js` 专项规则可再补 | eval 已 pass（14/14） |
| batch-4 | 19 条 | accepted | token 走 URL/写进页面、Sec-Fetch-Site 鉴权回退、symlink 越界、completed 后被改判 failed、错误码 400/404、流式读无 error 处理、审批自铸自批、library 删除不可回滚等 | R-10/R-11/R-12 已补规则 | eval 已 pass（19/19） |
| batch-5 | 12 条（2 major） | accepted | reload 绕过写链导致丢更新、上传落盘后异常留下孤儿文件、manifest 版本不校验、parentId 环无 visited、stat 错误被伪装 404 等 | R-13 编排修复；R-3/R-11 规则覆盖部分 | eval 已 pass（12/12），scan gate 已修 |
| batch-6 | 8 条 | accepted | 几何未钳制导致无界分配、解析异常吞成空页、FontDecoder 失败重复尝试、栏缝分配 off-by-one、居中短行固定落第 0 栏、死代码、混排打平破坏栏带 | R-14 已补 Python 规则 | eval 已 pass（8/8） |

## 5. eval 机制自身的三次修正（meta lesson）

1. **跨批次误报**：batch-2 的 run 只覆盖 gateway.js，batch-1 的 util.js 基线不该判漏报 → eval 按 run scope 过滤，记 `notEvaluated`。
2. **措辞/行号漂移**：同一问题两次运行标题不同、行号移动 → 增加「同文件近似行（±20）+ 中文 bigram 标题相似度」兜底。
3. **类别漂移 vs 类别族**：errors/security/concurrency 允许互认；tests 与代码类别不互认，避免「测试缺口」误配到代码 finding。

## 6. CI 自评审回合（真实 GitHub Actions，2026-11-16）

- PR #1 在加入 `DSH_API_KEY` 后两次真实运行：`review.yml` 用 `deepseek-flash / max` 评了 PR diff（首轮 2 条、修复后 3 条 minor，全部落在我们为插件写的测试上）。
- 首轮 2 条**是真问题**：归一化测试无法区分「null→空串」与「一律清空」；repo 参数测试受会话缓存影响、无法证明 repo 参与解析。→ 已按 finding 重写两个测试（不再依赖 review_scope 缓存，手动构造远端 run）。
- 第二轮 3 条是测试判别力的纯增强建议（minor），推送了 P-4 prompt 约束降噪。
- 第三轮（P-4 生效后）仍报 3 条 tests minor：模型把「断言无法区分『null→空串』与『一律清空』」视为「必然误通过」，属于 P-4 允许的报告范围。结论：**test-only diff 上的 tests 视角仍有 meta 噪声**，但都被判 minor、不阻断，可接受；后续可在 aggregate 增加「test-only diff 的 tests minor 降级」策略（待定）。
- 这验证了「CI 权威门禁 + 真实模型评审 + 找自身问题」的闭环确实工作，也说明 `tests` 视角在 PR 场景需要更严格的报告门槛。

## 7. 结论摘要

- 真实缺陷：batch-1 6 + batch-2 13 + batch-3 14 + batch-4 19 + batch-5 12（含 2 major）+ batch-6 8 = 72 条 accepted。
- 误报：batch-2 4 条 unit-scope 测试噪声（rejected）。
- 新增规则：11 条（R-1/R-2/R-3/R-5/R-6/R-7/R-10/R-11/R-12/R-14 已落，R-4 待落 core-data）。
- 编排修复：R-8 传输重试、R-9 temperature=0、R-13 scan 模式 preexisting/门禁语义。
- prompt 调整：4 处（P-1/P-2/P-4 已落，P-3 待批次契约）。
- 回归用例：72 accepted + 4 rejected；batch-3/4/5/6 的 eval 均全绿（missed 0 / noise 0），含首个 Python 批次。
- 产品改进：见 case README 表格（verdict 语义、report 结论、插件输出清洗、repo 参数、scan lenses、eval 匹配、规则、重试、温度）。
