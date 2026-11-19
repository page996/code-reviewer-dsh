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

数据（v2 初版）：

```json
ReviewProblem {
  id, title, severity, category,
  explanation: { what, whyImportant, evidence, unaffected, uncertainty },
  votes: { real, reject, human }, lenses: [], confidence,
  modules: ["lib", "client"], blastRadius: { files, callers, behavior, compatibility },
  autoFixable: bool, state: 'user-decision'|'queued-for-fix'|'fixed'|'ignored'
}
ReviewBatch { id, problemId, phase: 'core'|'impact'|'verification'|'contract',
  title, explanation, decisionPrompt, cards: [Card], coverage: {modules, files, excluded, unknown}, collapsed: bool }
ReviewCard { id, kind, location:{file,startLine,endLine}, excerpt:{from,to,lines,whySufficient},
  claim, evidence, impact, decisionOptions[], boundaries, confidence, links }
Decision { problemId/batchId/cardId, status, reason, decidedAt }
```

## 3. Agent 侧流程

1. **多视角独立评审**：按 lens 起独立上下文 reviewer，互不可见地产出候选（位置/证据/影响/置信度）。
2. **独立验证（反驳）**：每个候选起独立 verifier，检查调用方、复现路径、测试、契约，给出成立/不成立/需人工。
3. **投票与定级**：votes 决定 severity/confidence；分歧大→“需人工判断”问题。
4. **自动修复小问题**：可自动修复的 minor 直接进入修复任务（统一 diff + gate），不推给用户；用户只看突出问题和关键决策。
5. **聚类成 Problem**：同一根因跨位置/视角合并；记录来源 lens、票数、finding 指纹、原始 run。
6. **写卡（数量由 Agent 决定）**：
   - 每卡必须有精确位置、最小必要源码上下文（说明为什么这段就够）、证据、决策选项与后果、**明确边界**、置信度；
   - evidence/counter-evidence 卡必须包含反证与未知，不得只呈现支持结论的信息。
7. **批次**：一个 Problem 可有多批（core/impact/verification/contract），批次必须标注**跨模块**与覆盖/排除/未知；低优先级 minor 进折叠批次。
8. **完整性审计（推送前）**：独立上下文 reverse-check：原始 findings/diff/CI 是否存在被遗漏或隐藏反证的值得决策问题；不通过→补卡或生成“未解决批次”。
9. **排序**：不做固定顺序；队列按“最突出/最需决策”展示，并显示影响模块。

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
