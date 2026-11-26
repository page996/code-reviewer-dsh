# 审阅卡 v2：问题优先、注意力浓缩、IDE 投影

本文档固化 2026-11-20 与用户确认的方向修订与决策，是实现该机制的唯一事实源（与 `AGENT-TASK-SPEC.md` 并用）。

## 0. 已确认决策

| 决策 | 结论 |
| --- | --- |
| IDE | VS Code（优先 L2 深链 + L3 实时缓冲区扩展 + LSP 语义投影） |
| 源码注释 | 接受「审阅专用 worktree + 注释只写在该 worktree」；默认不改主工作树/目标分支 |
| L3 实时未保存缓冲区 | 需要 |
| LSP 语义投影（定义/引用/诊断悬浮） | 第一批实现 |
| 批次顺序 | 不做固定顺序；但必须在批次中标明**跨了哪些模块** |
| 「通过」语义 | 认可问题并进入**待修复队列**（不是“不改”）；大量小问题应在多 Agent 投票阶段就被修复，用户只看最突出问题和关键决策 |
| 低优先级 minor | 可折叠批次（默认收起） |
| gate | 默认 `.review/config.json` 的 `gate.commands`，面板可临时覆盖 |
| PR 写范围 | 行内评论 + 提交 review（approve/request-changes/comment）+ merge（二次确认） |
| 编辑粒度 | 多文件统一 diff，按批次 review/通过 |
| 审阅队列 | 不做一句话压缩，使用结构化多行说明 |
| 一次一个问题 | GUI 内投影渲染，不跳出到源文件；VS Code 仅作为「打开/实时缓冲区」通道 |

## 1. 目标（抽象）

**在尽量不丢信息的前提下，把用户的注意力浓缩到一个“经过 Agent 多视角独立评审并投票验证的问题”上。**

- 批次 = 一个逻辑审阅阶段（通常对应一个问题），不是物理分页；
- 一批审阅卡专注于一个问题，用户一次只聚焦一个；
- 卡片必须覆盖用户做决策所需的牵涉面：位置、证据、影响、选项与后果、边界（不覆盖什么）、不确定性；
- 大量 minor 在投票/验证阶段直接修复或折叠，不上浮到用户注意力。

## 2. 概念模型

```
ReviewProblem（值得用户决策的问题）
  ├─ 多 Agent 独立评审 → 候选 → 独立验证（反驳）→ 投票/定级 → 聚类
  ├─ 修复阶段：可自动修复的 minor 由 Agent 修复并进入待验证队列
  └─ ReviewBatch（一个问题的一个逻辑阶段；数量由 Agent 决定，无固定上限）
        ├─ ReviewCard(kind=defect|impact|evidence|counter-evidence)
        └─ Coverage：覆盖/排除/未知 + 跨模块清单 + 原始 finding 链接
Decision：approve（→ 待修复队列）/ needs-revision（→ Agent 任务）/ ignore（必须写理由）
```

数据（v2，2026-11-23 收口；实现于 `plugins/ci-review/lib/review-model.mjs` + `index.js`）：

```json
ReviewProblem {
  id, title, severity, gradedSeverity, category,
  explanation: { what, whyImportant, evidence, unaffected, uncertainty },
  votes: { confirmed, rejected, uncertain, pending, total }, lenses: [], confidence,
  verifiers: [{ id, stance, verdict, severity, confidence, reason, evidenceFor[], evidenceAgainst[], callSites[] }],
  modules: ["lib", "client"], blastRadius: { files, callers, behavior, compatibility },
  autoFixable: bool, state: 'user-decision'|'queued-for-fix'|'fixed'|'ignored'
}
ReviewBatch { id, problemId, phase: 'core'|'impact'|'verification'|'contract',
  title, explanation, decisionPrompt, rationale, grouping: {source:'agent'|'heuristic'},
  cards: [Card],
  coverage: { modules, files, reviewed[], excluded[], excludedDetails[], unknown[], unknownDetails[], linkedFiles[] },
  collapsed: bool }
ReviewCard { id, kind, location:{file,startLine,endLine}, excerpt:{from,to,lines,whySufficient},
  claim, evidence, impact, decisionOptions[], boundaries, confidence, links }
Decision { problemId/batchId/cardId, status, reason, decidedAt }
```

**投票规则**：N 个独立验证者（默认 3，`ciReview.verifiers` 1–5，**服务端策略**，请求体不能降级），不同立场（反证/调用方与测试/证据复现/回归历史/影响分级）。只有 `status=completed` 且带有效 verdict 的验证者计票；`running`/`failed` 进 `pending`/`failed`，不会提前产生结论。多数票（> N/2）决定 `confirmed|rejected`；全部 settled 且无多数才算 `uncertain`；置信度 high=全票、medium=多数、low=单票或分歧。`gradedSeverity` 只在 confirmed 时按确认者的 severity 票取多数（同票取更严重）。同一问题已有验证在运行时，重复请求被拒绝；迟到的旧 run 结果按 runId 丢弃；全部失败记 `status=failed`（可重试），不伪装成 completed。

**分组规则**：Agent 分组子代理接收全部 findings（稳定 key）+ 文件清单，输出逻辑审阅阶段（phase）与每批 `findingKeys`；批次数量由 Agent 决定。分组按「当前 findings 内容签名」与 HEAD 持久化，findings 集合变化时分组标记过期并回退启发式；未被任何分组覆盖的 findings 进入显式「未分组回退」批次，不会丢失。

**覆盖规则**：`reviewed` 仅认「已完成且 headSha === 当前 HEAD」的评审任务；`excluded` 来自最近 review scope 的 `excludeReason`（binary/unsupported/too_large/secret/...）或分组 Agent 声明；`unknown` 是相关文件没有 HEAD 证据（旧 revision、无 revision 的 CLI run、牵涉文件未验证）。三者互斥（reviewed 的文件不会再记为 unknown）。项目级摘要额外给出 fresh/excluded/unknown 文件数与 stale/staleUnknown 批次数。**CLI findings 没有 revision**：同一文件一旦有 HEAD 的完成评审任务，旧的 CLI findings 视为被取代（计数 `supersededCliFindings`），不再制造永久 unknown。

**收敛规则**：只有当前 HEAD 的评审任务算新鲜。`convergence` 给出总批次/旧代码/出处未知/新鲜/待重审文件（按严重度、stale 卡片数排序；单次上限取 `ciReview.convergeMaxFiles` 与请求值的较小者，硬上限 10），一键启动后台重审；新任务完成后最新任务覆盖旧任务，旧任务归档到 `superseded.json`。非 git/无法证明 HEAD 时 `plan.reason='no-head'`、不启动任务，面板显示「无法证明当前 HEAD」。

**批次定级约束**：批次 severity 取「Agent 声明」与「本批最严重卡片」中更严重者；`collapsed=true` 仅在全部卡片均为 minor 时生效——Agent 输出不能把 blocker 藏在折叠的 minor 批次里。

**分组状态**：`groupings.json` 按 HEAD 保存 `running|completed|failed`；running 时面板禁用重复启动，failed 暴露 error 并回退启发式；findings 集合变化（签名失配）→ `stale=true` 回退启发式并提示重新分组；未分组 findings 进入显式「未分组回退」批次。


## 3. Agent 侧流程

1. **多视角独立评审**：按 lens 起独立上下文 reviewer，互不可见地产出候选（位置/证据/影响/置信度）。
2. **独立验证（反驳）**：每个候选起独立 verifier，检查调用方、复现路径、测试、契约，给出成立/不成立/需人工。
3. **多验证者独立投票与定级**：每个候选起 N（默认 3）个独立上下文验证者（不同立场：反证 / 调用方与测试 / 证据复现 / 回归历史 / 影响分级），各自给出 `confirmed|rejected|uncertain` + 证据 + 建议 severity；多数票决定结论与置信度，severity 票决定 `gradedSeverity`；分歧大/未达多数→“需人工判断”问题。
4. **自动修复小问题**：可自动修复的 minor 直接进入修复任务（统一 diff + gate），不推给用户；用户只看突出问题和关键决策。
5. **聚类成 Problem**：同一根因跨位置/视角合并；记录来源 lens、票数、finding 指纹、原始 run。
6. **Agent 决定批次 + 写卡**：写卡前由分组子代理把全部 findings 组织成逻辑审阅阶段（`phase`），批次数量由 Agent 决定，不做物理分页；未被分组覆盖的 findings 必有回退批次。每卡必须有精确位置、最小必要源码上下文（说明为什么这段就够）、证据、决策选项与后果、**明确边界**、置信度；evidence/counter-evidence 卡必须包含反证与未知，不得只呈现支持结论的信息。
7. **批次**：一个 Problem 可有多批（core/impact/verification/contract），批次必须标注**跨模块**与覆盖/排除/未知；低优先级 minor 进折叠批次。
8. **完整性审计（推送前）**：独立上下文 reverse-check：原始 findings/diff/CI 是否存在被遗漏或隐藏反证的值得决策问题；审计输入包含分组来源与 coverage 摘要（stale/excluded/unknown）；不通过→补卡或生成“未解决批次”。
9. **收敛**：批次新鲜度只认「当前 HEAD 的已完成评审」；`convergence` 指标 + 一键按严重度批量重审，直到 stale/unknown 收敛。

## 4. 用户侧流程（GUI）

1. **审阅队列**：每个问题多行结构化说明（发生了什么/为什么重要/影响面/证据/不确定点），显示 severity、模块、状态（待决策/已通过→待修复/已修复/忽略）。
2. **一次一个问题**：进入批次后只呈现该问题；卡片流 + 源码投影。
3. **源码投影（VS Code 优先）**：
   - **L1 内建渲染（默认）**：按目标 ref 渲染精确字节、行号、标注带（选择原因/问题说明），锚点数据 sidecar，不修改真实源码；
   - **L2 VS Code 深链**：`vscode://file/<abs>:<line>:<col>`（Windows 注册）或 `code --goto <file>:<line>:<col>`；
   - **L3 VS Code 扩展（首批实现）**：本地 WebSocket/IPC 提供当前缓冲区（含未保存）、LSP 诊断、选区；面板只读投影，不提供 IDE 功能；
   - **LSP 语义**：hover/定义/引用/诊断，经 DSH 现有 LSP 能力读取。
4. **审阅专用 worktree（已确认）**：从目标 ref 创建 `review-annotations/<problem-id>` worktree；注释只写在该 worktree（前缀 `// [ci-review:<card-id>] ...`），不 commit/push/merge；VS Code 打开该 worktree 即可看到注释；渲染器读取同一 worktree 保证一致；JSON/Notebook 等无注释语法时降级为覆盖层。
5. **决策**：每卡或整批三选一：
   - **通过** = 认可问题 → 进入**待修复队列**；
   - **需修订** = 启动带完整问题上下文的子会话 Agent，改完展示**多文件统一 diff + gate 结果**，回到该批再决策；
   - **忽略** = 必须写理由。
6. **闭环**：阅读（投影）→ 决策 → Agent 修订（子会话）→ 多文件 diff + gate → 批次复核 → PR 行内评论/review/merge（全部带确认与失败原因）。

## 5. 兼容性策略

- 默认不改用户工作树：审阅注释在独立 worktree；主分支零污染、格式化工具有限影响、可整体丢弃；
- 无注释语法的文件（JSON/YAML 注释受限、Notebook、生成文件、二进制）：降级为覆盖层标注（sidecar）；
- 路径与锚点：内容 hash 锚定 + 行号映射，支持 CRLF/编码/tab 差异、Windows 盘符/junction、WSL/远程场景（VS Code 深链按平台适配）；
- IDE 缺失或未知：降级 L1 + 复制路径；
- 大文件/压缩/生成代码：片段渲染 + 明确提示，不假装完整。

## 6. 实施顺序

1. Problem 聚类 + Agent 决定批次（逻辑阶段）+ 卡片类型/边界/证据链 + 完整性审计（只读展示）；
2. GUI 审阅队列（多行说明、模块覆盖）、一次一个问题、L1 投影渲染与标注层；
3. 审阅 worktree + 注释写入（含前缀与清理）、L2 VS Code 深链；
4. L3 VS Code 扩展实时缓冲区 + LSP 语义投影（首批），gate 集成（config + 面板覆盖）；
5. 「通过→待修复队列」与自动修复 minor、多文件统一 diff、批次复核；
6. PR 行内评论 + review + merge。

## 7. 残余风险收口（2026-11-23，v2.1）

四项 MVP 残余风险的实现位置、配置与验证方式：

| 项 | 实现 | 配置 | HTTP API | 验证 |
| --- | --- | --- | --- | --- |
| 多验证者投票 | `lib/review-model.mjs::aggregateVotes/normalizeVerificationRecord/verifierPrompt`；`index.js::startVerification` | `ciReview.verifiers`（默认 3，1–5；服务端策略，请求体不可降级） | `POST /dsh-ci-review/api/review-problems/verify` | 单元测试 + 面板「多验证者投票（N 票）」 |
| Agent 决定批次 | `groupings.json`（按 HEAD + findings 签名持久化）、`startGrouping`、`buildReviewProblems` 优先 Agent 分组、启发式回退 | 无（Agent 输出决定数量） | `POST /dsh-ci-review/api/review-problems/group` | 单元测试 + 面板「Agent 逻辑分组/重新分组」 |
| coverage.excluded/unknown | `reviewEvidenceFor` + `coverageForBatch/buildProjectCoverage`；快照 `reviewCoverage` | 无 | 随 `GET /api/snapshot` 返回 | 单元测试 + 面板覆盖率行 |
| HEAD 收敛 | `planReReview` + `startConvergence`；任务完成即覆盖旧任务并归档 | `ciReview.convergeMaxFiles`（默认 3，硬上限 10）、`ciReview.convergeLenses`（默认 correctness/errors/security） | `POST /dsh-ci-review/api/review-job/converge`（`start:false` 只出计划） | 单元测试 + 面板「按 HEAD 重审收敛」 |

数据文件（均在 `<repo>/.review/ci-review/`，默认 gitignore）：
- `groupings.json`：`{version:2, byRevision:{<headSha>:{id,headSha,status,signature,groups[],coverage,generatedAt}}}`；findings 变化后签名失配→自动回退并提示重新分组。
- `verifications.json`：`{version:2, byProblem:{<problemKey>:{status,votes,verifiers[],verdict,confidence,gradedSeverity,history[]}}}`；旧的单验证者记录读取时归一化为 1 票 legacy 验证者。
- `review-jobs/*.json`：新增任务带 `headSha`；最新完成的任务按文件覆盖旧任务，旧的进入 `superseded.json`。

**仍未覆盖/已知限制**（不阻断 MVP）：
- 验证者之间仍是「同一模型的不同立场」，不是异构模型投票；票数上限 5，默认 3。
- Agent 分组依赖 LLM 输出质量；输出不合法/缺 key 时按启发式回退并把未覆盖 findings 放进显式回退批次，面板会显示分组来源与过期状态。
- Agent 分组切换后，旧版「位置式 problem id」的单验证者记录无法映射到新批次（仅启发式回退批次可按 legacy id 读回）；这类问题需要重新验证，不会伪造结论。
- 收敛是手动/一键触发（不自动 infinite loop），`convergeMaxFiles` 限制单次启动数量；修复后 HEAD 前进仍会重新产生 stale，需继续收敛（这是评审系统的正常循环，不是功能缺陷）。非 git/无 HEAD 时不启动重审。
- CLI run（`lib/`）的 findings 没有 revision，无法证明新鲜度：coverage 会如实标 unknown；同一文件有 HEAD 完成任务后旧 CLI findings 视为被取代并计数，不再制造永久 unknown。

