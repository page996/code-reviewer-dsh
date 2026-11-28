# lessons — paper-translator

> 覆盖范围：batch-1 … batch-30（含 batch-2b 复评）。每条 lesson 必须落到具体文件（规则 / prompt / 回归用例 / 项目口径），否则不算沉淀。

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
| R-15 | batch-7：同一问题被 correctness/security 两个视角在同行报成两条，措辞差异大，标题相似度 0.12 → 未合并 | 跨视角合并只看标题相似度，无法识别“同因不同表述” | 已加同文件同行相似标题合并 + `review aggregate` 无模型重算；措辞差异极大的重复仍会保留（已知限制，后续可加 LLM dedupe pass） | `lib/aggregate.mjs` + `bin/review.mjs`（已加） | batch-7 复算 20 条；R-15 限制记录 |
| R-16 | batch-10（client.js）：fetch 无超时、fire-and-forget PUT 吞错、并发刷新旧响应覆盖新状态、updater 内改 ref、不可信 HTML iframe 无 sandbox、href 未校验协议 | JS 规则包缺「前端/React/网络调用」高频模式 | 新增前端与网络调用条目 | `rules/lang-js-ts.md`（已加） | batch-10 真实命中 |
| R-17 | batch-11/12：workspace 的 SVG 内联预览 XSS、写最终目标未校验 symlink（TOCTOU）、`deleteEntry` 检查不可达；notes-store 的墓碑计入配额导致永久 409、schemaVersion 只写不读、孤儿节点 | 安全/数据规则缺「真实路径写入校验」「软删除/墓碑生命周期」判据 | 新增条目 | `rules/core-data.md`（已加）；workspace 安全项归 core-security/lang-js-ts | batch-11/12 真实命中 |
| R-18 | batch-13/14：CSS 选择器拼接只转义引号、图片 URL 任意主机、`querySelector` 换行逃逸；重复函数定义/双 click 绑定；`{ok:false}` 被当成功 | JS 规则包缺「前端注入面/重复绑定/响应信封校验」判据 | 新增五条前端条目 | `rules/lang-js-ts.md`（已加） | batch-13/14 真实命中 |
| R-19 | batch-15/16：审批对话框把「exists 未知」的覆盖写描述成新建；确认框不可用时破坏性操作改为无确认执行（fail-open）；视觉批量接口无条目/字节上限；provider 原始错误透传；`Number(null)=0` 参与 confidence/页码 | 安全规则缺「审批展示真实性/破坏性操作 fail-open/批量配额/错误透传」，coercion 规则已有但缺 confidence 场景 | 新增安全条目 + 复核 core-correctness coercion 条目 | `rules/core-security.md`（已加） | batch-15/16 真实命中 |
| R-20 | batch-17/18：`Number(null)=0` 页码/confidence、未翻译用源文回填导致 `untranslated` 恒 false、协议字段缺失回落 `'en'`、blockId 键类型不一致、manifest 空 lockedImage 产出空 url | 数据规则缺「unknown vs 空」与「缺字段回落具体值」判据 | 新增数据生命周期补充条目 | `rules/core-data.md`（已加） | batch-18 真实命中 |
| R-21 | batch-19/20：evidence 把原始 fs/JSON 错误文本持久化进 warnings；audit 的 actor 未知时静默回退 `system`、`maxRotated=0` 语义与文档相反、rotate 把 stat 错误当不存在 | 安全规则缺「审计身份回退最受信角色/错误文本持久化」判据 | 新增审计身份条目 | `rules/core-security.md`（已加） | batch-19/20 真实命中 |
| R-22 | batch-21/22/23：viewer-state 先改内存再持久化失败不回滚、`Boolean('false')`/`Number(null)` 清洗、clean 重写 updatedAt；alignment 缩写表与真实 `e.g.` 不匹配、裸 `$...$` 跨句；skills 空串 skill 与互斥校验不一致、服务端状态映射成 400 | 数据规则缺「持久化顺序/类型强转/时间戳保真」；契约规则缺「字段存在性 vs 值语义」判据 | 新增数据顺序条目 + 契约高频问题补充 | `rules/core-data.md`（已加）；契约项归 core-contract | batch-21/22/23 真实命中 |
| R-23 | batch-24/25：skill-store 把非 ENOENT 读错误当文件缺失→seed 覆盖用户数据（blocker）、版本不认识=损坏并隔离重建；note-sessions 的 `note.cwd` 未规范化直接作 Agent 工作目录、文档称 fail-closed 但策略绑定失败仍继续 | 安全规则缺「声明 fail-closed 却 fail-open」「未校验路径直接进 Agent 作用域」判据 | 新增安全条目 | `rules/core-security.md`（已加） | batch-24/25 真实命中 |
| R-24 | batch-26：2,041 行 graph.js 单请求易触发传输失败/上下文过长；跨视角同行重复合并后 votes 并集让 2 条 major 达到票数门槛 | 大文件需要切 unit；跨视角去重会改变 votes 语义（可能把降级为 minor 的 major 恢复） | 新增 scan 单文件按行切分（`plan.splitSingleFileLines`，默认 1200）+ 行区间锚定；聚合去重的 votes 并集语义写入文档 | `lib/plan.mjs`（已加）；`lib/aggregate.mjs` 已有 | batch-26 实测 2 单元、28→30 条（含 3 major）、无传输失败 |
| R-25 | batch-27/batch-2b（DSH 重启后）：新 lib 生效后 scan 自动跳过 tests、temperature=0、单文件自动切分；gateway 复评旧基线 matched 13/13、noise 0，新增 5 条并入后 28/28 | 之前 batch-2 的 noise/漂移确为旧运行时缓存 + 未固定采样导致，非代码回归 | 无需再改；把「重启后复验」写入运维检查清单 | `docs/ARCHITECTURE.md` 或 README 运维节（后续补） | 已实测通过 |
| R-26 | batch-27：`loadKatex(assetUrl)` 缓存命中忽略新 assetUrl；`katexVersion()` 空 catch 把环境失败当空；bundle 加载失败与 LaTeX 解析失败合并成同一个 `{ok:false}` | 错误域混同/缓存键不完整 | core-errors 新增「失败域混同」条目 | `rules/core-errors.md`（已加） | batch-27 真实命中 |
| R-27 | batch-30：llm.js 单视角 schema 失败（坏转义 JSON）导致该视角缺失；callLlm 对一切错误一律重试、provider status/code 未参与判定 | schema 重试预算过小（1 次）；重试策略未分类 | reviewer schema 重试提升到 attempt 预算（3 次）；scan 模式 needs-human 不再单独触发 exit 3（仅 reviewer 失败保留）；core-errors 新增重试分类条目 | `lib/review.mjs` + `lib/gate.mjs` + `rules/core-errors.md`（已加） | 单测 + batch-30 重跑完整 30 条 |
| R-8（补） | batch-10 首轮 4.7k 行 client.js 出现 2 次 `DeepSeek Messages transport failed`（大 prompt 更易瞬时失败），重跑成功 | 大文件单 unit 的请求更易触发传输中断；重试代码已在 main，插件尚缓存旧 lib | 重启后由 reviewer 重试覆盖；必要时后续加「超大单文件切 unit」 | `lib/review.mjs`（已加） | 重启后重跑 batch-10 观察不再丢视角 |

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
| E-77…E-96 | batch-7 的 20 条 floats.py 缺陷（含 2 major，accepted） | 仍被报出；batch-7 run 的 eval：matched 20 / missed 0 / noise 0 | `findings.json` |
| E-97…E-111 | batch-8 的 15 条 render_paper.py 缺陷（accepted） | 仍被报出；batch-8 run 的 eval：matched 15 / missed 0 | `findings.json` |
| E-112…E-123 | batch-9 的 12 条 mathconv.py 缺陷（accepted） | 仍被报出；batch-9 run 的 eval：matched 12 / missed 0 | `findings.json` |
| E-124…E-140 | batch-10 的 17 条 client.js 缺陷（accepted） | 仍被报出；batch-10 run 的 eval：matched 17 / missed 0 | `findings.json` |
| E-141…E-164 | batch-11 的 24 条 workspace.js 缺陷（accepted） | 仍被报出；batch-11 run 的 eval：matched 24 / missed 0 | `findings.json` |
| E-165…E-180 | batch-12 的 16 条 notes-store.js 缺陷（accepted） | 仍被报出；batch-12 run 的 eval：matched 16 / missed 0 | `findings.json` |
| E-181…E-198 | batch-13 的 18 条 doc-reader.js 缺陷（含 1 major，accepted） | 仍被报出；batch-13 run 的 eval：matched 18 / missed 0 | `findings.json` |
| E-199…E-212 | batch-14 的 14 条 graph-view.js 缺陷（accepted） | 仍被报出；batch-14 run 的 eval：matched 14 / missed 0 | `findings.json` |
| E-213…E-227 | batch-15 的 15 条 workbench.js 缺陷（accepted） | 仍被报出；batch-15 run 的 eval：matched 15 / missed 0 | `findings.json` |
| E-228…E-240 | batch-16 的 13 条 visual.js 缺陷（accepted） | 仍被报出；batch-16 run 的 eval：matched 13 / missed 0 | `findings.json` |
| E-241…E-246 | batch-17 的 6 条 compare.js 缺陷（accepted） | 仍被报出；batch-17 run 的 eval：matched 6 / missed 0 | `findings.json` |
| E-247…E-256 | batch-18 的 10 条 document.js 缺陷（含 1 major，accepted） | 仍被报出；batch-18 run 的 eval：matched 10 / missed 0 | `findings.json` |
| E-257…E-272 | batch-19 的 16 条 evidence.js 缺陷（accepted） | 仍被报出；batch-19 run 的 eval：matched 16 / missed 0 | `findings.json` |
| E-273…E-286 | batch-20 的 14 条 audit.js 缺陷（accepted） | 仍被报出；batch-20 run 的 eval：matched 14 / missed 0 | `findings.json` |
| E-287…E-304 | batch-21 的 18 条 viewer-state.js 缺陷（含 1 major，accepted） | 仍被报出；batch-21 run 的 eval：matched 18 / missed 0 | `findings.json` |
| E-305…E-315 | batch-22 的 11 条 alignment.js 缺陷（accepted） | 仍被报出；batch-22 run 的 eval：matched 11 / missed 0 | `findings.json` |
| E-316…E-324 | batch-23 的 9 条 skills.js 缺陷（accepted） | 仍被报出；batch-23 run 的 eval：matched 9 / missed 0 | `findings.json` |
| E-325…E-341 | batch-24 的 17 条 skill-store.js 缺陷（含 1 blocker，accepted） | 仍被报出；batch-24 run 的 eval：matched 17 / missed 0 | `findings.json` |
| E-342…E-357 | batch-25 的 16 条 note-sessions.js 缺陷（accepted） | 仍被报出；batch-25 run 的 eval：matched 16 / missed 0 | `findings.json` |
| E-358…E-387 | batch-26 的 30 条 graph.js 缺陷（3 major + 27 minor，accepted） | 仍被报出；batch-26 run 的 eval：matched 30 / missed 0 | `findings.json` |
| E-388…E-406 | batch-27 的 19 条 katex-verify.js 缺陷（1 major + 18 minor，accepted） | 仍被报出；batch-27 run 的 eval：matched 19 / missed 0 | `findings.json` |
| E-407…E-421 | batch-2b 的 15 条 gateway.js 复评 findings（15 条全部并入基线，其中约 10 条与旧 13 条语义近重复、措辞差异大未被去重合并） | 仍被报出；重启后 eval matched 28/28（含旧 13 accepted + 2b 并入的 15；其他批次 notEvaluated） | `findings.json` |
| E-422…E-451 | batch-28 的 30 条 extract_paper.py 缺陷（accepted） | 仍被报出；batch-28 run 的 eval：matched 30 / missed 0 / new 0 | `findings.json` |
| E-452…E-459 | batch-29 的 8 条 pages_to_png.py 缺陷（accepted） | 仍被报出；batch-29 run 的 eval：matched 8 / missed 0 | `findings.json` |
| E-460…E-489 | batch-30 的 30 条 llm.js 缺陷（accepted） | 仍被报出；batch-30 run 的 eval：matched 30 / missed 0 | `findings.json` |

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
| batch-7 | 20 条（2 major） | accepted | 中文题注「表」判成 figure、无上限 O(n²) drawings、契约外 kind=region、解析异常吞成空、调试日志泄露原文、渲染上限滞后等 | R-15 去重机制 + R-14 部分 | eval 已 pass（20/20） |
| batch-8 | 15 条 | accepted | markdown 围栏未中和（注入）、公式编号被剥、缺 translations 仍 return 0、meta 泄露绝对路径/先截断后写、字体重复嵌入等 | core-security/core-errors + R-14 | eval 已 pass（15/15） |
| batch-9 | 12 条 | accepted | CMap 解析无上限、字体发现宽泛 except、`Piece.glyphs` 契约不一致、花括号递归无深度上限、√ 分隔符错序、KaTeX 硬化分支写反等 | R-14 补充「不可信文本递归/CMap 上限」 | eval 已 pass（12/12） |
| batch-10 | 17 条 | accepted | 枚举值/实际值不一致、fetch 无超时、token 进 URL/iframe、成环文件夹树、破坏性确认未禁用、不可信 HTML iframe 同源无 sandbox、href 伪协议、active-view PUT 吞错与并发覆盖、updater 内改 ref 等 | R-16 已补前端/网络规则；R-8 记录大文件瞬态失败 | eval 已 pass（17/17） |
| batch-11 | 24 条 | accepted | SVG 内联预览 XSS、写最终目标未校验 symlink、`deleteEntry` 检查不可达、`..` 前缀合法路径误判、保留路径大小写敏感、Windows 设备名、部分删除状态、doc.json 每次重写、回滚不完整等 | R-17 覆盖部分；安全项归 core-security | eval 已 pass（24/24） |
| batch-12 | 16 条 | accepted | 墓碑计入配额导致永久 409、schemaVersion 只写不读、配额计数把 tmp/墓碑算进去、节点孤儿、`get`/`list` 校验不一致、字段命名不一致、parent 环未校验等 | R-17 已补软删除/墓碑条目 | eval 已 pass（16/16） |
| batch-13 | 18 条（1 major） | accepted | CSS 选择器注入（换行逃逸）、图片 URL 任意主机、公式成功仍挂失败徽章、无 IntersectionObserver 时后续段永不渲染、KaTeX 未加载即删 data-tex、拖拽失败不回滚、teardown 未清 class 等 | R-18 已补前端条目 | eval 已 pass（18/18） |
| batch-14 | 14 条 | accepted | 重复 click 绑定绕过忙锁、函数重复定义静默覆盖、`{ok:false}` 当成功、图加载失败永久占位、改名成功却报失败、预览与提交集合不一致、Esc 捕获关闭全屏等 | R-18 已补前端条目 | eval 已 pass（14/14） |
| batch-15 | 15 条 | accepted | 审批把覆盖写描述成新建、确认框失败开放（无确认执行）、NDJSON 末尾残留丢弃、切换随笔不中止读流、message 监听不校验 source、加载失败渲染成空目录、旧响应覆盖新列表等 | R-19 已补安全条目 | eval 已 pass（15/15） |
| batch-16 | 13 条 | accepted | `Number(null)=0` 影响 confidence/页码、视觉探测失败与不支持混为一谈、provider 原始错误透传、批量图片无配额更、解析失败仍返回“干净成功”、未知 code 静默塌缩等 | R-19 已补安全条目 | eval 已 pass（13/13） |
| batch-17 | 6 条 | accepted | blockById 缺可选链、caption 容器 key 归一化不一致、title/abstract 无条件跳过而 front 行按元数据生成（同一问题多视角重复，R-15 限制） | 规则已有部分覆盖 | eval 已 pass（6/6） |
| batch-18 | 10 条（1 major） | accepted | `Number(null)=0` 页码、id 类型不一致、extraction/translations 损坏静默降级、源文回填使 untranslated 恒 false、协议字段缺失回落 `'en'`、空 lockedImage 产出空 url 等 | R-20 已补数据规则 | eval 已 pass（10/10） |
| batch-19 | 16 条 | accepted | 原始 fs/解析错误文本持久化进 warnings、非 ENOENT 读错与损坏一视同仁、`.bak` 复制时机错误、entry 形状随接口不同、命中去重忽略 noteId/tags、blob 落盘失败仍写索引 | R-3/R-21 覆盖部分 | eval 已 pass（16/16） |
| batch-20 | 14 条 | accepted | actor 未知回退 `system`（伪造系统操作）、`maxRotated=0` 语义与文档相反、rotate 把 stat 错误当不存在、readdir 错误吞成空、轮转段不可读被静默跳过等 | R-21 已补审计身份条目 | eval 已 pass（14/14） |
| batch-21 | 18 条（1 major） | accepted | 先改内存再持久化失败不回滚、`Boolean('false')`/`Number(null)` 强转、clean 重写 updatedAt、copyFile 空 catch、`load` 用 clean 破坏时间戳等 | R-22 已补数据顺序条目 | eval 已 pass（18/18） |
| batch-22 | 11 条 | accepted | 数学正则惰性匹配可被未闭合定界符拖垮、裸 `$...$` 跨句吞句、缩写表 `eg/ie` 与真实 `e.g./i.e.` 不匹配、句首引号缺排印字符等 | core-security ReDoS + core-correctness 覆盖 | eval 已 pass（11/11） |
| batch-23 | 9 条 | accepted | 服务端状态映射成 400、空串 skill 与互斥校验不一致、title 可空性假设不一致等 | core-errors/core-contract 覆盖 | eval 已 pass（9/9） |
| batch-24 | 17 条（1 blocker） | accepted | 非 ENOENT 读错当文件缺失→seed 覆盖用户数据、版本不认识=损坏并隔离重建、atomicWrite 把好备份覆盖成损坏、load 提前置 loaded、list 契约不一致等 | R-23 + R-3/core-data 覆盖 | eval 已 pass（17/17）；scan gate 不阻断 |
| batch-25 | 16 条 | accepted | 消息正则误判 session 不存在、TODO 白名单未生效、create 失败原因丢失、`note.cwd` 未校验进 Agent 作用域、声明 fail-closed 却 fail-open、exists/approval 只凭进程内缓存等 | R-23 已补安全条目 | eval 已 pass（16/16） |
| batch-26 | 30 条（3 major） | accepted | 快照写失败仍成功、GC 先删快照后写主文件无补偿、fs/JSON 错误文本持久化进 warnings、隔离 rename 失败仍写成功、节点上限检查在插入后且含墓碑、无环校验超深当不存在、跨视角重复合并后 votes 并集使 major 达标 | R-24 单文件切分 + 聚合 votes 语义 | eval 已 pass（30/30）；无传输失败 |
| batch-27 | 19 条（1 major） | accepted | 上标分支写成行首锚点、loadKatex 缓存命中忽略 assetUrl、环境失败与解析失败合并、fs 错误文本进 catch、白名单未排除、编号提取超出文档来源、括号平衡只统计圆括号等 | R-26 已补「失败域混同」 | eval 已 pass（19/19） |
| batch-2b | 15 条（5 条新增） | accepted | 重启后新 lib 复评 gateway：旧 13 条全部命中、无 tests 噪声、采样稳定；新增 5 条并入基线 | R-25 验证记录 | eval 已 pass（28/28） |
| batch-28 | 30 条 | accepted | 不可信页面宽度当计数桶/循环次数（无界内存与 CPU）、栏缝扫描未钳制索引、docstring 与人名形态矛盾、`detect_style_columns` 契约不一致等 | R-14/R-19 覆盖部分 | eval 已 pass（30/30） |
| batch-29 | 8 条 | accepted | 空 `--pages` 当 all、默认全量渲染无页数/字节配额、`NAME_RE` 尾 `$` 放行换行、渲染尺寸未限制页面几何、多文件写失败不清理/不记录、失败退出契约与实现不符 | R-14/R-19 覆盖 | eval 已 pass（8/8） |
| batch-30 | 30 条 | accepted | callLlm 覆盖 onUsage、重试不看 provider status/code、搜索 URL 无协议校验、maxTerms 1–3 被当未设置、glossary 返回契约不稳定、术语条数无硬上限（可放大 web 搜索）、verified 判定过弱、状态覆盖后不重算等 | R-27 + core-errors/core-security 覆盖 | eval 已 pass（30/30） |

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

- 真实缺陷：batch-1…29 累计 455 + batch-30 30 = 485 条 accepted（含 1 blocker + 11 major）。
- 误报：batch-2 4 条 unit-scope 测试噪声（rejected）。
- 新增规则：20 条（R-1…R-23 除 R-4 外均已落 + R-26 失败域混同 + R-27 重试分类）。
- 编排/机制修复：R-8 传输重试、R-9 temperature=0、R-13 scan preexisting/门禁语义、R-15 跨视角同类合并 + `review aggregate`、R-24 单文件切分、R-27 schema 重试预算 + scan needs-human 语义、eval 排除 dropped；R-25 重启后复验通过。
- prompt 调整：4 处（P-1/P-2/P-4 已落，P-3 待批次契约）。
- 回归用例：485 accepted + 4 rejected；batch-3…30 与 batch-2b 的 eval 均全绿（missed 0 / noise 0）。
- 已知覆盖缺口（诚实记录）：batch-26/28/30 另有 48 条聚合 findings 因 max-comments 上限被丢弃（实际类别见 case README 批次表，并非 style/docs），未做 disposition、未入基线；后续应提高上限或分批复评。batch-2 的原始 run 记录被 batch-2b 复评覆盖，其 17 条 findings 仅存于本 case 导出。
- dispositions.json 曾以批量模板 reason 错误标注各批次为「batch-3」；已迁移到 v1 包装 schema（补 date/severity/endLine），466 条 reason 按各自 findings 的实际批次改写，`lib/eval.mjs` 同步接受文档化 schema。
- 产品改进：见 case README 表格（verdict 语义、report 结论、插件输出清洗、repo 参数、scan lenses、eval 匹配、规则、重试、温度）。
