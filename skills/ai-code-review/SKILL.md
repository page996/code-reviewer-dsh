---
name: ai-code-review
description: "仅在真实代码仓库里写码、改码、重构、修 bug、加测试、调整构建或 CI 配置，或评审真实 diff/PR 时加载。执行 R0–R6 评审闭环：任务契约 → 覆盖率 100% 的准备 → 独立上下文多视角评审 → 确定性门禁 → 人工放行 → 发布/回滚 → 逃逸缺陷沉淀。不要用于：讨论 code review 方法、写文章/教程/方案/文档、工具选型、概念答疑，或没有真实代码仓库与文件改动的场景。"
whenToUse: "当前任务确实要改真实代码，或要评审真实 diff/PR 并决定能否合入/发布时；纯讨论、写作、规划、聊天里的代码片段不加载。"
---

# AI Code Review v2（工具执行 + skill 判定）

评审由本仓库 `dsh-code-reviewer` 执行（CLI 或 DSH 工具），本 skill 只回答：**何时用哪个命令、按什么标准判定、谁签字**。
禁止手工伪造 findings、手算票数、手写行号——机器可判定的事全部交给工具。

## 0. 适用性自检

三条都满足才继续，否则明确说「本任务不属于真实代码开发，本 skill 不适用」：

- 有真实仓库与真实改动：`git status --short` / `git diff --stat` 非空；或明确要对某目录做全量 scan；
- 能定位执行器：CLI `node bin/review.mjs`（工具仓库内）或 DSH 工具 `review_scope`；
- 任务会改或审源码、测试、构建/部署配置、依赖、CI 脚本之一。

## 1. 核心原则

1. **contract-first**：R0 先写任务契约（目标/验收/非目标/风险级别/允许范围/回滚），缺一项先问人。
2. **写审分离**：写码 Agent 不自审；评审是独立上下文、无工具、只读——由 `review run` 的纯 prompt 调用保证，不靠自觉。
3. **机器可验证优先**：lint/type/test/构建/SARIF 进 `review gate`；人只看机器证不了的设计与假设。
4. **证据签字**：签字四问 + 门禁证据 + 绑定 commit SHA；L1+ 必须人类批准，Agent 永不代签。
5. **逃逸棘轮**：每个逃逸缺陷必须变成规则/prompt/回归用例资产，且能用 `review eval` 复跑。

## 2. 风险分级（变更决定等级，不是作者）

| 级别 | 典型变更（收紧口径） | 机器门禁 | 人工动作 |
|---|---|---|---|
| L0 低 | 文档/注释/文案；纯格式化且无逻辑变化 | gate + `--effort quick` 可选 | 免逐行审，确认证据并留记录；免签不免责 |
| L1 中 | 普通功能/UI/内部工具；小依赖升级；**新增或调整测试**（改测试=改标准，最低 L1） | gate + `--effort standard` 多视角 | 读关键 diff + 测试证据后签字 |
| L2 高 | 认证/授权/支付/计费/数据删除迁移/对外契约/CI 与发布/系统提示词/密钥权限/并发事务；**删改关键断言、跳过测试、放宽匹配** | gate + `--effort deep` + 红队 + 仿真/回滚演练 | 深读设计+关键 diff；外部人 review；灰度 + 演练回滚 |
| L3 不可逆 | 大规模生产数据迁移/删除、资金、合规 | 不自动执行；dry-run + 备份 + 变更窗口 | 人工执行/逐步确认 + 外部复核 |

> 测试变更永远不是低风险；`--effort quick` 只用于 L0 或先扫一遍，不作为 L1+ 的放行依据。

## 3. 状态机（R0 → R6）

### R0 契约
- 有 git 且只审本次改动：`node bin/review.mjs all --mode range --base main --contract REVIEW.md --json`；无 git 或全仓库体检：`node bin/review.mjs scan --path <dir> --effort deep --json`。
- 契约模板 `templates/contract.md`；项目口径用 `templates/REVIEW.md`、`templates/AGENTS.md` 的最小版。
- 缺验收标准或允许范围不清 → 先问人，不写码。

### R1 准备
- `node bin/review.mjs scope --mode range --base main --head HEAD --json`（或 `workspace|staged|commit|scan`）；DSH：`review_scope`。
- `node bin/review.mjs plan --run <runId> --effort standard|deep`；DSH：`review_plan`。
- 覆盖率硬性 100%：`scope.json` 中每个文件要么 reviewable，要么有 `excludeReason`；`coverage.complete=true`、`coverage.unreviewed=[]`；`plan.json.skippedFiles` 能解释全部跳过项。
- 覆盖率不足 ≠ 通过：必须在报告列未审文件与原因，由人确认可接受。

### R2 评审
- `node bin/review.mjs run --run <runId> --effort standard`（L2 用 `deep`；需要验证轮加 `--rounds 2`）；DSH：`review_run`。
- 视角由 effort 决定：quick=intent,correctness；standard=+errors,security,tests,contract；deep=全 10 视角且 rounds≥2；`--lenses a,b` 可覆盖。
- 工具执行的硬约束（勿绕过）：每条 finding 必须带 `existing_code`；能锚定则给 `startLine/endLine`，不能则 `anchored=false` 进 needs-human；`evidence` 为空的 major/blocker 降 needs-human；major/blocker 需 ≥`review.votesForMajor`（默认 2）个不同视角票。
- 轮次：第 2 轮是验证轮，只审已确认 findings + 其所在文件的新 diff；≤3 轮，不收敛就停（见 §4）。

### R3 门禁
- `node bin/review.mjs gate --run <runId>`；DSH：`review_gate`；产物 `.review/runs/<runId>/gate.json`。
- 退出码是唯一判定，不看模型自然语言：`0` 通过；`2` 有 blocking findings；`3` needs-human>0；`4` 必需门禁命令失败；`5` 引擎/配置错误（用法错误为 `1`）。`review all/scan` 直接把 gate 退出码作为进程退出码。
- `2`/`3` 不得口头放行：要么修，要么 R4 由人按四问决策并记录；`4` 修命令/环境或显式豁免写进报告；`5` 是工具故障，禁止当通过。
- 探测与失败处理见 `references/gates.md`；CI 权威判定同样只看 `gate.json` 与退出码。

### R4 人工放行
- `node bin/review.mjs report --run <runId> --format md`（或 DSH `review_report`），报告贴 PR/交付说明。
- 签字四问（L1+）：解决什么/不解决什么；依赖哪些假设、假设不成立会怎样；哪些检查能证明、哪些不能；出问题怎么发现、影响面、怎么回滚。
- 只签**具体 commit SHA**；有后续提交就重跑门禁并重签；记录模板见 `templates/REVIEW.md` 末尾「放行记录」。
- L0 免逐行审但要人确认证据留记录；**Agent 不能批准 L1+**，也不能代填签字人。

### R5 发布/回滚
- flag/灰度/分批；发布后烟测与监控；回滚必须演练过。
- 事故顺序：先止血（关 flag/回滚）→ 再定位 → 修复 + 补用例。
- 边界：DSH 内工具是**软门禁**（只约束本会话流程）；git hook 可被 `REVIEW_SKIP_HOOKS=1` 跳过；**权威门禁是 CI/远端 branch protection**。

### R6 逃逸沉淀
- 每个逃逸缺陷/确认误报进 `cases/<repo>/`：`README.md`（范围/结论）、`findings.json`（从 run 的 `aggregate.json.findings` 导出）、`dispositions.json`（accepted|rejected|ignored|fixed + 原因）、`lessons.md`（规则缺口/prompt 调整/回归用例）。
- 每条 lesson 落到具体文件：`rules/*.md` 新规则、`references/prompts.md` 视角调整，或 case 回归用例；写清改哪个文件。
- `node bin/review.mjs eval --case cases/<repo> --json` 回归；`node bin/review.mjs runs --json` 或 DSH `review_ledger` 对比历次。

## 4. 硬规则

- diff ≤300 行**有效改动**（非空、非纯格式化/重排的行；生成物、锁文件不计）；一次一个目的。
- 同时在飞、未签字的变更 ≤2；超限先清队列再派活。
- 新功能默认放 flag 后；不可开关的改动风险级别上调一档。
- 测试不可作弊：禁止为过门禁删/弱化断言、skip 测试、放宽匹配；发现即按 L2 处理，不进 R4。
- 一次批准只对一个 commit；Agent 提交、merge、rebase 后必须重跑 `review gate` 并重签。
- 3 轮不收敛即停：写明不收敛原因，回 R0 缩范围/改设计；禁止 Agent 互喂循环。
- needs-human 既不能当 blocker 压作者，**也不许静默丢弃**：逐条给出处置（人工确认/转 issue/补证据重审），并在报告 needs-human 区可见。

## 5. 产物与路径

```text
<repo>/.review/
├── config.json                  # 配置，模板 templates/.review-config.json
├── rules/*.md                   # 项目规则包（frontmatter：paths/severityHint）
└── runs/<runId>/                # meta.json、scope.json、rules.json、plan.json、
                                 # reviews.json（每 unit×lens 原始输出）、
                                 # aggregate.json（聚合 findings）、report.md、report.json、
                                 # report.sarif、gate.json
cases/<repo>/                    # README.md、findings.json（取 aggregate.json 的 findings）、
                                 # dispositions.json、lessons.md
```

- runId 形如 `run-YYYYMMDD-HHmmss-<4hex>`；`--run latest` 解析最近一次 run；路径一律仓库相对 POSIX，不出现盘符。
- `.review/` 默认 gitignore；报告作为 CI artifact 上传，不提交。
- 找不到 run：`node bin/review.mjs runs --json` 列出。

## 6. 参考文件

| 文件 | 何时读 |
|---|---|
| `references/workflow.md` | 每阶段输入/输出/证据/失败降级、无 git、无 key 路径 |
| `references/prompts.md` | 10 视角 reviewer prompt、JSON 契约、filter/红队/修复批次 |
| `references/gates.md` | 门禁探测、失败处理、退出码、branch protection |
| `references/ci.md` | GitHub Actions（PR/SARIF/评论/fork）与 GitLab 对照 |
| `references/reporting.md` | md/json/sarif 字段、行内评论定位、成本统计 |
| `references/hooks.md` | pre-commit/pre-push 边界、fast/full、逃生口 |
| `references/cases.md` | 经验飞轮、dispositions 四态、`review eval` |

路径相对本 skill 目录；按需读，不要一次性全加载。模板在工具仓库 `templates/`。

## 7. 完成前自检

- [ ] R0 契约四问有答案，范围/非目标/回滚明确
- [ ] R1 `scope.json` 覆盖率 100%（reviewed 或 skipped 有名有因）
- [ ] R2 `review run` 完成，findings 全部 anchored 或标 needs-human，轮次 ≤3
- [ ] R3 `gate.json` 存在且退出码已处理（0 通过；2/3/4/5 有明确处置记录）
- [ ] R4 签字四问 + commit SHA 已记录；L1+ 是人类签字
- [ ] R5 回滚可执行；发布后有烟测
- [ ] R6 逃逸/误报已进 cases，且落到具体规则/prompt/用例
