/**
 * Client half of the CI review workbench.
 *
 * A global sidebar panel (sidebar.panellist + main) that shows, per selected
 * project, what is happening (PR, checks, Actions runs, local review runs,
 * sessions) and what the user can do next. Data comes from the package's Host
 * half over the same-origin /dsh-ci-review API.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-ci-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const DICT = {
      zh: {
        panelLabel: 'CI 评审',
        title: 'CI 评审工作台',
        subtitle: '现在正在发生什么，以及你接下来能做什么',
        refresh: '刷新',
        refreshing: '刷新中…',
        updated: '更新于 {time}',
        loading: '加载中…',
        noProjects: '还没有项目。在 DSH 中打开一个工作区，或在本 bundle 配置里添加项目。',
        noProjectsHint: '可在「插件管理 → CI 评审工作台 → 配置」中加 projects：[{ "name": "my-repo", "root": "C:\\\\path" }]。',
        projects: '项目',
        now: '正在发生什么',
        next: '你可以做什么',
        githubReady: 'GitHub · 已认证',
        githubMissing: 'GitHub · 未连接',
        githubReasonMissingRemote: '没有检测到该项目的 GitHub remote。',
        githubReasonMissingToken: '没有找到 GitHub 凭据（GITHUB_TOKEN / git credential）。',
        githubReasonNotGit: '该目录不是 Git 仓库。',
        pullRequest: '拉取请求',
        noPullRequest: '当前分支没有打开的 PR。',
        createPullRequest: '创建 PR',
        openPullRequest: '打开 PR',
        openActions: '打开 Actions',
        openRepo: '打开仓库',
        copyBranch: '复制分支名',
        copied: '已复制',
        checks: '检查',
        checksNone: '该提交还没有检查。',
        checkFailed: '失败',
        checkRunning: '运行中',
        checkSuccess: '通过',
        checkQueued: '排队中',
        checkSkipped: '已跳过',
        checkNeutral: '中性',
        checkUnknown: '未知',
        checksSummary: '{passed} 通过 · {failed} 失败 · {running} 运行中',
        runs: '最近的 Actions 运行',
        runsNone: '该分支没有找到 workflow 运行。',
        localReviews: '本地评审运行',
        localReviewsNone: '.review/runs 里还没有评审。',
        reviewCounts: 'blocker {blocker} · major {major} · minor {minor}',
        sessions: '该项目中的会话',
        sessionsNone: '该项目还没有 DSH 会话记录。',
        branch: '分支',
        dirty: '{count} 个未提交改动',
        clean: '工作区干净',
        noHead: '还没有提交',
        error: '加载失败',
        retry: '重试',
        notGit: '该目录不是 Git 仓库。',
        summaryWithPr: 'PR #{number} {state} · {checks} · {reviews}',
        summaryNoPr: '{branch} · {dirty} · 无打开的 PR',
        summaryChecksPass: '全部检查通过',
        summaryChecksFail: '{count} 个检查失败',
        summaryChecksRunning: '{count} 个检查运行中',
        summaryChecksNone: '暂无检查',
        summaryReviewReady: '等待你审阅',
        summaryReviewDone: '已提交审阅',
        stateOpen: '打开',
        stateDraft: '草稿',
        stateMerged: '已合并',
        stateClosed: '已关闭',
        mergeable: '可合并',
        conflicting: '与基线冲突',
        mergeUnknown: '可合并性未知',
        timeJustNow: '刚刚',
        timeMinutes: '{count} 分钟前',
        timeHours: '{count} 小时前',
        timeDays: '{count} 天前',
        detailsOpen: '详情',
        sourceGitCredential: '令牌来自 git credential',
        sourceEnv: '令牌来自环境变量',
        sourceNone: '无令牌',
        baseInfo: '本地信息',
        generatedAt: '面板数据生成于 {time}',
        tokenHint: '注意：GitHub 数据只读且未配置凭据，PR/检查信息不可用。',
        authFailed: '认证失败，请刷新页面重试。',
        dataSourceForge: '数据源：forge（gh 已登录）',
        dataSourceRest: '数据源：REST（gh 未就绪）',
        reviewDecision: '审阅结论',
        reviewApproved: '已批准',
        reviewChanges: '要求修改',
        reviewRequired: '等待审阅',
        reviewNone: '无审阅',
        unresolvedThreads: '{count} 条未解决评论',
        failedChecks: '{count} 个检查失败',
        rerunFailed: '重跑失败检查',
        markReady: '标记为可审阅',
        updateBranch: '更新分支',
        mergePr: '合并 PR',
        mergeConfirm: '合并会改变远端仓库状态，确定继续？',
        actionRunning: '提交中…',
        actionDone: '操作已提交',
        actionFailed: '操作失败',
        runDetailLoading: '读取运行详情…',
        runDetailFailed: '读取运行详情失败',
        jobs: '任务',
        steps: '步骤',
        noSteps: '没有步骤信息',
        jobFailed: '失败',
        jobSuccess: '通过',
        jobRunning: '运行中',
        jobQueued: '排队',
        branchUpdated: '分支更新方式',
        annotations: '本地批注',
        annotationsNone: '还没有批注。',
        annotationsHelp: '用法（三步）：① 在下方填写文件（相对项目根）、起始行、批注内容，点「添加批注」——这就是对指定位置的审阅；② 在批注行点「让 Agent 修订」；③ 在「后台 Agent 修订任务」里补充指令并启动，完成后审阅报告。',
        annotationFileExample: '如 plugins/ci-review/client.js',
        annotationFile: '文件（相对项目根）',
        annotationLine: '起始行',
        annotationEndLine: '结束行（可选）',
        annotationBody: '批注内容',
        annotationAdd: '添加批注',
        annotationSaved: '批注已保存',
        annotationOpen: '待处理',
        annotationAddressed: '已处理',
        annotationWontfix: '不处理',
        annotationMarkAddressed: '标记已处理',
        annotationMarkOpen: '重新打开',
        annotationDelete: '删除',
        annotationAskAgent: '让 Agent 修订',
        severityInfo: '提示',
        severityWarning: '警告',
        severityCritical: '严重',
        agentTasks: '后台 Agent 修订任务',
        agentTasksExplain: '后台 Agent 是一个独立上下文的子代理：它按你的指令在项目里修改文件、运行测试，并把「结论 / 改动 / 可能后果 / 测试 / 未解决 / 下一步」汇报到这里。它不会 commit、push、merge 或批准 PR，所以改完仍由你决定是否保留。',
        agentTasksFlow: '用法：先在「本地批注」里点「让 Agent 修订」，或直接在下方填写指令；启动后任务卡会实时显示运行状态，完成后展开报告逐项审阅。',
        agentTasksNone: '还没有后台任务。可以在批注上点「让 Agent 修订」开始。',
        agentInstruction: '给 Agent 的指令',
        agentStart: '启动后台 Agent',
        agentStarting: '正在启动…',
        agentCancel: '取消任务',
        agentStatusRunning: '运行中',
        agentStatusCompleted: '已完成',
        agentStatusFailed: '失败',
        agentStatusBlocked: '需要你决策',
        agentStatusCancelled: '已取消',
        agentSummary: '结论',
        agentChanges: '改动',
        agentConsequences: '可能后果',
        agentTests: '测试',
        agentUnresolved: '未解决',
        agentNextSteps: '下一步',
        agentTestsPlanned: '计划',
        agentTestsExecuted: '已执行',
        agentTestsNotRun: '未执行',
        agentRiskLevel: '风险',
        agentTarget: '目标',
        agentDraftTitle: '准备交给后台 Agent',
        agentDraftHint: '指令已根据批注预填，可以继续补充。Agent 在独立上下文运行，不会自动 commit/push/merge。',
        agentStarted: '后台 Agent 已启动',
        agentStartFailed: '启动失败',
        agentChildSession: '子会话',
        agentNoInstruction: '请先填写指令',
        helpTitle: '使用说明：这个面板怎么用',
        helpText: '① 左上角选项目 → 中间看「正在发生什么」（PR、检查、Actions 运行、本地评审、会话）。\n② 点 Actions 运行可展开 job / step 看 CI 进度与失败点。\n③ 在「本地批注」填文件（相对项目根，如 plugins/ci-review/client.js）、起始行、内容 → 点「添加批注」，这就是对指定位置的审阅。\n④ 在批注行点「让 Agent 修订」；在「后台 Agent 修订任务」里可再填目标文件/行号和指令 → 点「启动后台 Agent」。\n⑤ Agent 在独立上下文修改文件并运行测试，完成后在任务卡展示：结论 / 改动 / 可能后果 / 测试 / 未解决 / 下一步（中文）。它不会 commit/push/merge，改完由你决定是否保留。\n\n按钮含义：刷新=重新拉取状态；重跑失败检查=只重跑失败的 workflow；标记为可审阅=草稿 PR 转正式；更新分支=把基线合入当前分支；合并 PR=按所选方式合并（会二次确认）；打开 PR/创建 PR/Actions/仓库=跳转 GitHub；复制分支名=复制当前分支；标记已处理/重新打开/删除=管理批注状态；取消任务=停止后台 Agent。\n\n禁用的按钮下方会写出原因（例如「没有失败的检查」「PR 不是草稿」「与基线冲突」）。',
      },
      en: {
        panelLabel: 'CI review',
        title: 'CI review workbench',
        subtitle: 'What is happening now, and what you can do next',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        updated: 'Updated {time}',
        loading: 'Loading…',
        noProjects: 'No project yet. Open a workspace in DSH, or add a project in this bundle config.',
        noProjectsHint: 'Add projects in Plugin Manager → CI review workbench → config.projects = [{ "name": "my-repo", "root": "C:\\\\path" }].',
        projects: 'Projects',
        now: 'What is happening',
        next: 'What you can do',
        githubReady: 'GitHub · authenticated',
        githubMissing: 'GitHub · not connected',
        githubReasonMissingRemote: 'No GitHub remote detected for this project.',
        githubReasonMissingToken: 'No GitHub credential found (GITHUB_TOKEN / git credential).',
        githubReasonNotGit: 'This folder is not a Git repository.',
        pullRequest: 'Pull request',
        noPullRequest: 'No open pull request for this branch.',
        createPullRequest: 'Create pull request',
        openPullRequest: 'Open pull request',
        openActions: 'Open Actions',
        openRepo: 'Open repository',
        copyBranch: 'Copy branch',
        copied: 'Copied',
        checks: 'Checks',
        checksNone: 'No checks yet for this commit.',
        checkFailed: 'failed',
        checkRunning: 'running',
        checkSuccess: 'passed',
        checkQueued: 'queued',
        checkSkipped: 'skipped',
        checkNeutral: 'neutral',
        checkUnknown: 'unknown',
        checksSummary: '{passed} passed · {failed} failed · {running} running',
        runs: 'Recent Actions runs',
        runsNone: 'No workflow run found for this branch.',
        localReviews: 'Local review runs',
        localReviewsNone: 'No review run in .review/runs yet.',
        reviewCounts: 'blocker {blocker} · major {major} · minor {minor}',
        sessions: 'Sessions in this project',
        sessionsNone: 'No DSH session recorded for this project yet.',
        branch: 'branch',
        dirty: '{count} uncommitted change(s)',
        clean: 'worktree clean',
        noHead: 'No commit yet',
        error: 'Failed to load',
        retry: 'Retry',
        notGit: 'This folder is not a Git repository.',
        summaryWithPr: 'PR #{number} {state} · {checks} · {reviews}',
        summaryNoPr: '{branch} · {dirty} · no open PR',
        summaryChecksPass: 'all checks passed',
        summaryChecksFail: '{count} check(s) failed',
        summaryChecksRunning: '{count} check(s) in progress',
        summaryChecksNone: 'no checks',
        summaryReviewReady: 'waiting for your review',
        summaryReviewDone: 'review submitted',
        stateOpen: 'open',
        stateDraft: 'draft',
        stateMerged: 'merged',
        stateClosed: 'closed',
        mergeable: 'mergeable',
        conflicting: 'conflicts with base',
        mergeUnknown: 'mergeability unknown',
        timeJustNow: 'just now',
        timeMinutes: '{count} min ago',
        timeHours: '{count} h ago',
        timeDays: '{count} d ago',
        detailsOpen: 'Details',
        sourceGitCredential: 'token from git credential',
        sourceEnv: 'token from environment',
        sourceNone: 'no token',
        baseInfo: 'Local information',
        generatedAt: 'Snapshot generated {time}',
        tokenHint: 'GitHub data is unavailable because no credential is configured.',
        authFailed: 'Authentication failed; refresh the page and retry.',
        dataSourceForge: 'Source: forge (gh signed in)',
        dataSourceRest: 'Source: REST (gh not ready)',
        reviewDecision: 'Review',
        reviewApproved: 'approved',
        reviewChanges: 'changes requested',
        reviewRequired: 'review required',
        reviewNone: 'no review',
        unresolvedThreads: '{count} unresolved thread(s)',
        failedChecks: '{count} check(s) failed',
        rerunFailed: 'Rerun failed checks',
        markReady: 'Mark ready for review',
        updateBranch: 'Update branch',
        mergePr: 'Merge PR',
        mergeConfirm: 'Merging changes the remote repository. Continue?',
        actionRunning: 'Submitting…',
        actionDone: 'Submitted',
        actionFailed: 'Action failed',
        runDetailLoading: 'Loading run detail…',
        runDetailFailed: 'Failed to load run detail',
        jobs: 'Jobs',
        steps: 'Steps',
        noSteps: 'No step information',
        jobFailed: 'failed',
        jobSuccess: 'passed',
        jobRunning: 'running',
        jobQueued: 'queued',
        branchUpdated: 'Branch updates',
        annotations: 'Local annotations',
        annotationsNone: 'No annotations yet.',
        annotationsHelp: 'How to use: (1) fill file (relative to the project root), start line and the annotation text, then click "Add annotation" — this is how you review a specific location; (2) click "Ask agent to fix" on that annotation; (3) refine the instruction and start the background agent in the task card, then review its report.',
        annotationFileExample: 'e.g. plugins/ci-review/client.js',
        annotationFile: 'File (relative to project root)',
        annotationLine: 'Start line',
        annotationEndLine: 'End line (optional)',
        annotationBody: 'Annotation',
        annotationAdd: 'Add annotation',
        annotationSaved: 'Annotation saved',
        annotationOpen: 'open',
        annotationAddressed: 'addressed',
        annotationWontfix: 'wontfix',
        annotationMarkAddressed: 'Mark addressed',
        annotationMarkOpen: 'Reopen',
        annotationDelete: 'Delete',
        annotationAskAgent: 'Ask agent to fix',
        severityInfo: 'info',
        severityWarning: 'warning',
        severityCritical: 'critical',
        agentTasks: 'Background agent tasks',
        agentTasksExplain: 'A background agent is a subagent with its own context: it edits files in the project and runs tests per your instruction, then reports Summary / Changes / Possible consequences / Tests / Unresolved / Next steps here. It never commits, pushes, merges or approves, so you stay in control.',
        agentTasksFlow: 'Use "Ask agent to fix" on an annotation, or write an instruction below. The task card shows live status; when it finishes, review the report item by item.',
        agentTasksNone: 'No background task yet. Use "Ask agent to fix" on an annotation.',
        agentInstruction: 'Instruction for the agent',
        agentStart: 'Start background agent',
        agentStarting: 'Starting…',
        agentCancel: 'Cancel task',
        agentStatusRunning: 'running',
        agentStatusCompleted: 'completed',
        agentStatusFailed: 'failed',
        agentStatusBlocked: 'needs your decision',
        agentStatusCancelled: 'cancelled',
        agentSummary: 'Summary',
        agentChanges: 'Changes',
        agentConsequences: 'Possible consequences',
        agentTests: 'Tests',
        agentUnresolved: 'Unresolved',
        agentNextSteps: 'Next steps',
        agentTestsPlanned: 'planned',
        agentTestsExecuted: 'executed',
        agentTestsNotRun: 'not run',
        agentRiskLevel: 'risk',
        agentTarget: 'target',
        agentDraftTitle: 'Prepare a background agent task',
        agentDraftHint: 'The instruction is prefilled from the annotation; add details. The agent runs in an independent context and never commits, pushes or merges.',
        agentStarted: 'Background agent started',
        agentStartFailed: 'Failed to start',
        agentChildSession: 'child session',
        agentNoInstruction: 'Instruction is required',
        helpTitle: 'How to use this panel',
        helpText: '1. Pick a project on the left; the centre shows what is happening (PR, checks, Actions runs, local reviews, sessions).\n2. Click an Actions run to expand jobs/steps.\n3. Under "Local annotations", fill file (relative to project root), start line and text, then click "Add annotation" — that is how you review a specific location.\n4. Click "Ask agent to fix" on the annotation; in the task card you may add a target file/line and instruction, then click "Start background agent".\n5. The agent edits files in an independent context and runs tests, then reports Summary / Changes / Possible consequences / Tests / Unresolved / Next steps. It never commits/pushes/merges.\n\nButtons: Refresh = reload state; Rerun failed checks = rerun only failed workflows; Mark ready = convert a draft PR; Update branch = merge the base into the head branch; Merge PR = merge with confirmation; Open PR/Create PR/Actions/Repository = jump to GitHub; Copy branch = copy the branch name; Mark addressed/Reopen/Delete = manage an annotation; Cancel task = stop the background agent.\n\nA disabled button lists its reason below the row (e.g. "no failed checks", "PR is not a draft", "conflicts with base").',
      },
    };

    const CSS = `
.dr-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-sizing:border-box;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dr-header{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dr-headline{flex:1;min-width:0}
.dr-title{margin:0;font-size:17px;font-weight:600;line-height:1.3}
.dr-subtitle{margin:2px 0 0;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
.dr-header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dr-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-1,#fff)}
.dr-dot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-idle-primary,#9ca3af);flex:none}
.dr-dot.ok{background:var(--dsw-alias-state-success-primary,#16a34a)}
.dr-dot.bad{background:var(--dsw-alias-state-error-primary,#dc2626)}
.dr-dot.warn{background:var(--dsw-alias-state-warn-primary,#d97706)}
.dr-dot.run{background:var(--dsw-alias-brand-primary,#2563eb)}
.dr-body{flex:1;min-height:0;display:grid;grid-template-columns:240px minmax(0,1fr);gap:0}
.dr-list{border-right:1px solid var(--dsw-alias-border-l1,#e5e7eb);overflow:auto;padding:10px}
.dr-list-head{padding:4px 8px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#6b7280)}
.dr-project{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;padding:7px 9px;margin:0 0 2px;cursor:pointer;font:inherit}
.dr-project:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.dr-project[data-active="true"]{background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-color:var(--dsw-alias-border-l2,#d1d5db)}
.dr-project-name{display:flex;align-items:center;gap:6px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-project-meta{display:flex;align-items:center;gap:6px;margin-top:2px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-main{min-width:0;overflow:auto;padding:16px 18px 28px}
.dr-card{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:10px;padding:12px 14px;margin:0 0 12px}
.dr-card-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.dr-card-title{margin:0;font-size:13px;font-weight:600}
.dr-card-title-sub{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;font-weight:400}
.dr-spacer{flex:1}
.dr-summary{font-size:14px;line-height:1.5;margin:0 0 10px}
.dr-badges{display:flex;flex-wrap:wrap;gap:6px}
.dr-badge strong{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dr-muted{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin:0}
.dr-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px dashed var(--dsw-alias-border-l1,#e5e7eb);font-size:12px}
.dr-row:first-of-type{border-top:none}
.dr-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-row-state{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;white-space:nowrap}
.dr-input{border:1px solid #c7ced8;border-radius:6px;background:#ffffff;color:#1f2328;padding:4px 7px;font:inherit;font-size:12px}
.dr-textarea{resize:vertical;min-height:56px}
.dr-input:focus{outline:2px solid #1f6feb;outline-offset:-1px}
.dr-input::placeholder{color:#7a8494}
.dr-link{color:var(--dsw-alias-brand-primary,#2563eb);text-decoration:none}
.dr-link:hover{text-decoration:underline}
.dr-actions{display:flex;flex-wrap:wrap;gap:8px}
.dr-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #c7ced8;border-radius:8px;background:#eef1f5;color:#1f2328;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;font-weight:500}
.dr-btn:hover:not(:disabled){background:#e2e7ee;border-color:#aab4c0}
.dr-btn:disabled{opacity:1;cursor:not-allowed;background:#f6f7f9;color:#3f4854;border-color:#d5dbe3}
.dr-btn.primary{background:#1f6feb;border-color:#1f6feb;color:#ffffff}
.dr-btn.primary:hover:not(:disabled){background:#1a5fd0;border-color:#1a5fd0;opacity:1}
.dr-link{color:#1f6feb;text-decoration:none;font-weight:500}
.dr-link:hover{text-decoration:underline}
.dr-btn.dr-link{background:transparent;border:none;color:#1f6feb;padding:0;font-weight:500;text-align:left}
.dr-btn.dr-link:hover:not(:disabled){background:transparent;text-decoration:underline}
.dr-notice{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-left:3px solid var(--dsw-alias-state-warn-primary,#d97706);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);font-size:12px;margin:0 0 10px}
.dr-error{border-left-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dr-empty{padding:28px 10px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280)}
.dr-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;padding:1px 5px}
.dr-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dr-footer{padding:8px 2px 0;display:flex;flex-wrap:wrap;gap:12px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px}
.dr-spin{display:inline-block;width:10px;height:10px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2,#d1d5db);border-top-color:var(--dsw-alias-brand-primary,#2563eb);animation:dr-spin .8s linear infinite}
@keyframes dr-spin{to{transform:rotate(360deg)}}
@media (max-width:760px){.dr-body{grid-template-columns:1fr}.dr-list{border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);max-height:180px}}
`;

    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (params && params[key] !== undefined ? String(params[key]) : `{${key}}`));
    }

    function apiBase() {
      return (typeof window !== 'undefined' && window.__DSH_CI_REVIEW_BASE__) || '/dsh-ci-review/';
    }

    function apiToken() {
      return (typeof window !== 'undefined' && window.__DSH_CI_REVIEW_TOKEN__) || '';
    }

    async function request(apiPath, options) {
      const opts = options || {};
      const headers = { 'x-dsh-ci-review-token': apiToken(), ...(opts.headers || {}) };
      if (opts.body && typeof opts.body === 'string') headers['content-type'] = 'application/json';
      const response = await fetch(apiBase() + apiPath.replace(/^\/+/, ''), { ...opts, headers });
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { ok: false, error: text.slice(0, 300) };
      }
      if (response.status === 401) throw new Error('UNAUTHORIZED');
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    function relativeTime(iso, t) {
      if (!iso) return '';
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return '';
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (seconds < 60) return t('timeJustNow');
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return interpolate(t('timeMinutes'), { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 36) return interpolate(t('timeHours'), { count: hours });
      const days = Math.round(hours / 24);
      return interpolate(t('timeDays'), { count: days });
    }

    function checkTone(item) {
      if (item.status && item.status !== 'completed') return { tone: 'run', label: item.status === 'queued' ? 'checkQueued' : 'checkRunning' };
      if (item.conclusion === 'success') return { tone: 'ok', label: 'checkSuccess' };
      if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(item.conclusion)) return { tone: 'bad', label: 'checkFailed' };
      if (['skipped', 'neutral', 'stale'].includes(item.conclusion)) return { tone: 'idle', label: 'checkSkipped' };
      return { tone: 'warn', label: 'checkUnknown' };
    }

    function runTone(run) {
      if (run.status !== 'completed') return run.status === 'queued' ? 'warn' : 'run';
      if (run.conclusion === 'success') return 'ok';
      if (['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(run.conclusion)) return 'bad';
      return 'idle';
    }

    function Icon(owner) {
      const size = owner && owner.size ? owner.size : 20;
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, fill: 'var(--dsw-alias-brand-primary,#1f6feb)' }),
        h('path', { d: 'M20 18v20', stroke: '#fff', strokeWidth: 4, strokeLinecap: 'round' }),
        h('circle', { cx: 20, cy: 44, r: 5, fill: '#fff' }),
        h('path', { d: 'M44 20v20', stroke: '#fff', strokeWidth: 4, strokeLinecap: 'round' }),
        h('circle', { cx: 44, cy: 46, r: 5, fill: '#fff' }),
        h('path', { d: 'M20 30h10a7 7 0 0 1 7 7v1', stroke: '#fff', strokeWidth: 4, strokeLinecap: 'round', fill: 'none' }),
      );
    }

    function Card(props) {
      return h('section', { className: 'dr-card' }, props.children);
    }

    function Badge(props) {
      return h(
        'span',
        { className: 'dr-badge', title: props.title || '' },
        h('span', { className: `dr-dot ${props.tone || ''}` }),
        props.children,
      );
    }

    function useWorkbench(t) {
      const [projects, setProjects] = React.useState([]);
      const [selectedId, setSelectedId] = React.useState('');
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [refreshing, setRefreshing] = React.useState(false);
      const [updatedAt, setUpdatedAt] = React.useState(0);
      const generation = React.useRef(0);

      const loadProjects = React.useCallback(async () => {
        const data = await request('api/projects');
        setProjects(data.projects || []);
        setSelectedId((current) => {
          if (current && (data.projects || []).some((project) => project.id === current)) return current;
          return data.projects?.[0]?.id || '';
        });
      }, []);

      const loadSnapshot = React.useCallback(async (projectId, force) => {
        if (!projectId) {
          setSnapshot(null);
          return;
        }
        const requestId = (generation.current += 1);
        if (force) setRefreshing(true);
        try {
          const data = force
            ? await request(`api/refresh?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' })
            : await request(`api/snapshot?projectId=${encodeURIComponent(projectId)}`);
          if (requestId !== generation.current) return;
          setSnapshot(data);
          setUpdatedAt(Date.now());
          setError('');
        } catch (cause) {
          if (requestId !== generation.current) return;
          setError(cause?.message === 'UNAUTHORIZED' ? t('authFailed') : String(cause?.message || cause));
        } finally {
          if (force) setRefreshing(false);
          setLoading(false);
        }
      }, [t]);

      React.useEffect(() => {
        let cancelled = false;
        loadProjects()
          .catch((cause) => {
            if (cancelled) return;
            setError(String(cause?.message || cause));
            setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [loadProjects]);

      React.useEffect(() => {
        if (!selectedId) return undefined;
        loadSnapshot(selectedId, false);
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          loadSnapshot(selectedId, false);
        }, 15000);
        return () => clearInterval(timer);
      }, [selectedId, loadSnapshot]);

      return {
        projects,
        selectedId,
        selectProject: (id) => {
          setSelectedId(id);
          setLoading(true);
          setSnapshot(null);
        },
        snapshot,
        error,
        loading,
        refreshing,
        updatedAt,
        refresh: () => selectedId && loadSnapshot(selectedId, true),
        retry: () => {
          setError('');
          loadProjects().catch((cause) => setError(String(cause?.message || cause)));
          if (selectedId) loadSnapshot(selectedId, true);
        },
      };
    }

    function SummaryCard({ snapshot, t }) {
      const project = snapshot.project;
      const pr = snapshot.github?.pr;
      let sentence;
      if (!pr) {
        const branch = project.git ? project.branch || t('noHead') : t('notGit');
        const dirty = project.dirty > 0 ? interpolate(t('dirty'), { count: project.dirty }) : t('clean');
        sentence = interpolate(t('summaryNoPr'), { branch, dirty });
      } else {
        const counts = pr.checks?.counts ?? {};
        const checks = counts.failed > 0
          ? interpolate(t('summaryChecksFail'), { count: counts.failed })
          : counts.running > 0
            ? interpolate(t('summaryChecksRunning'), { count: counts.running })
            : pr.checks?.items?.length
              ? t('summaryChecksPass')
              : t('summaryChecksNone');
        const reviews = pr.reviews?.decision === 'changes_requested' ? t('summaryReviewReady')
          : pr.reviews?.decision === 'approved' ? t('summaryReviewDone')
            : t('summaryReviewReady');
        const state = pr.draft ? t('stateDraft') : pr.state === 'closed' ? t('stateClosed') : t('stateOpen');
        sentence = interpolate(t('summaryWithPr'), { number: pr.number, state, checks, reviews });
      }
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('now')), h('span', { className: 'dr-spacer' })),
        h('p', { className: 'dr-summary' }, sentence),
        h(
          'div',
          { className: 'dr-badges' },
          h(Badge, { tone: project.git ? 'ok' : 'warn' }, project.branch || t('notGit')),
          project.dirty > 0 ? h(Badge, { tone: 'warn' }, interpolate(t('dirty'), { count: project.dirty })) : null,
          pr ? h(Badge, { tone: pr.checks?.rollup === 'failure' ? 'bad' : pr.checks?.rollup === 'pending' ? 'run' : pr.checks?.rollup === 'success' ? 'ok' : 'idle' }, t('checks')) : null,
          pr?.mergeableState ? h(Badge, { tone: pr.mergeableState === 'conflicting' || pr.mergeableState === 'dirty' ? 'bad' : 'ok' }, pr.mergeableState === 'conflicting' || pr.mergeableState === 'dirty' ? t('conflicting') : pr.mergeableState === 'unknown' ? t('mergeUnknown') : t('mergeable')) : null,
          pr?.reviewDecision ? h(Badge, { tone: pr.reviewDecision === 'changes_requested' ? 'bad' : pr.reviewDecision === 'approved' ? 'ok' : 'warn' }, pr.reviewDecision === 'approved' ? t('reviewApproved') : pr.reviewDecision === 'changes_requested' ? t('reviewChanges') : t('reviewRequired')) : null,
          pr?.unresolvedThreads > 0 ? h(Badge, { tone: 'warn' }, interpolate(t('unresolvedThreads'), { count: pr.unresolvedThreads })) : null,
          snapshot.github?.available ? h(Badge, { tone: 'ok' }, t('githubReady')) : h(Badge, { tone: 'warn' }, t('githubMissing')),
        ),
      );
    }

    function GitHubNotice({ snapshot, t }) {
      const github = snapshot.github || {};
      if (github.available) return null;
      const reason = github.status === 'missing-remote' ? t('githubReasonMissingRemote')
        : github.status === 'missing-token' ? t('githubReasonMissingToken')
          : github.status === 'not-git' ? t('githubReasonNotGit')
            : github.reason || t('githubReasonMissingToken');
      return h('div', { className: 'dr-notice' }, h('div', null, reason), h('div', { className: 'dr-muted' }, t('tokenHint')));
    }

    function PrCard({ snapshot, t }) {
      const github = snapshot.github;
      const pr = github?.pr;
      const links = snapshot.capabilities || {};
      if (!pr) {
        return h(
          Card,
          null,
          h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('pullRequest'))),
          h('p', { className: 'dr-muted' }, t('noPullRequest')),
          h(
            'div',
            { className: 'dr-actions' },
            links.createPrUrl ? h('a', { className: 'dr-btn', href: links.createPrUrl, target: '_blank', rel: 'noreferrer' }, t('createPullRequest')) : null,
            links.openRepoUrl ? h('a', { className: 'dr-btn', href: links.openRepoUrl, target: '_blank', rel: 'noreferrer' }, t('openRepo')) : null,
          ),
        );
      }
      const checks = pr.checks?.items ?? [];
      const counts = pr.checks?.counts ?? {};
      return h(
        Card,
        null,
        h(
          'div',
          { className: 'dr-card-head' },
          h('h3', { className: 'dr-card-title' }, `${t('pullRequest')} #${pr.number}`),
          h('span', { className: 'dr-card-title-sub' }, pr.headRef ? `${pr.headRef} → ${pr.baseRef}` : ''),
          h('span', { className: 'dr-spacer' }),
          pr.htmlUrl ? h('a', { className: 'dr-link', href: pr.htmlUrl, target: '_blank', rel: 'noreferrer' }, t('detailsOpen')) : null,
        ),
        h('p', { className: 'dr-summary', style: { marginBottom: '6px' } }, pr.title || ''),
        h(
          'div',
          { className: 'dr-badges', style: { marginBottom: '8px' } },
          h(Badge, { tone: pr.reviewDecision === 'approved' ? 'ok' : pr.reviewDecision === 'changes_requested' ? 'bad' : 'warn' },
            `${t('reviewDecision')}: ${pr.reviewDecision === 'approved' ? t('reviewApproved') : pr.reviewDecision === 'changes_requested' ? t('reviewChanges') : t('reviewRequired')}`),
          pr.unresolvedThreads > 0 ? h(Badge, { tone: 'warn' }, interpolate(t('unresolvedThreads'), { count: pr.unresolvedThreads })) : null,
          pr.checks?.counts?.failed > 0 ? h(Badge, { tone: 'bad' }, interpolate(t('failedChecks'), { count: pr.checks.counts.failed })) : null,
          pr.headSha ? h('span', { className: 'dr-muted' }, pr.headSha.slice(0, 12)) : null,
        ),
        h(
          'p',
          { className: 'dr-muted', style: { marginBottom: '10px' } },
          checks.length
            ? interpolate(t('checksSummary'), { passed: counts.passed ?? 0, failed: counts.failed ?? 0, running: counts.running ?? 0 })
            : t('checksNone'),
        ),
        checks.length
          ? h(
              'div',
              null,
              ...checks.map((item) =>
                h(
                  'div',
                  { className: 'dr-row', key: `${item.kind}-${item.name}` },
                  h('span', { className: `dr-dot ${checkTone(item).tone}` }),
                  h('span', { className: 'dr-row-name', title: item.name }, item.name),
                  h('span', { className: 'dr-row-state' }, t(checkTone(item).label)),
                  item.url ? h('a', { className: 'dr-link', href: item.url, target: '_blank', rel: 'noreferrer' }, '↗') : null,
                ),
              ),
            )
          : null,
      );
    }

    function RunsCard({ snapshot, t, projectId }) {
      const github = snapshot.github;
      const runs = github?.pr?.runs ?? [];
      const [openRunId, setOpenRunId] = React.useState(0);
      const [detail, setDetail] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [detailError, setDetailError] = React.useState('');
      if (!github?.available) return null;
      const toggle = async (runId) => {
        if (openRunId === runId) {
          setOpenRunId(0);
          return;
        }
        setOpenRunId(runId);
        setDetail(null);
        setDetailError('');
        setDetailLoading(true);
        try {
          const data = await request(`api/run?projectId=${encodeURIComponent(projectId)}&runId=${runId}`);
          setDetail(data);
        } catch (cause) {
          setDetailError(String(cause?.message || cause));
        } finally {
          setDetailLoading(false);
        }
      };
      const jobTone = (job) => {
        if (job.status && job.status !== 'completed') return job.status === 'queued' ? 'warn' : 'run';
        if (job.conclusion === 'success') return 'ok';
        if (['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(job.conclusion)) return 'bad';
        return 'idle';
      };
      const stepTone = (step) => {
        if (step.status !== 'completed') return step.status === 'queued' ? 'warn' : 'run';
        if (step.conclusion === 'success') return 'ok';
        if (step.conclusion === 'failure') return 'bad';
        return 'idle';
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('runs')), h('span', { className: 'dr-spacer' }),
          h('a', { className: 'dr-link', href: snapshot.capabilities?.actionsUrl || '#', target: '_blank', rel: 'noreferrer' }, t('openActions'))),
        runs.length
          ? runs.map((run) =>
              h(
                React.Fragment,
                { key: String(run.id) },
                h(
                  'div',
                  { className: 'dr-row' },
                  h('span', { className: `dr-dot ${runTone(run)}` }),
                  h('button', { className: 'dr-link', type: 'button', style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }, onClick: () => toggle(run.id) }, run.name || `#${run.id}`),
                  h('span', { className: 'dr-row-state' }, `${run.conclusion || run.status} · ${relativeTime(run.createdAt, t)}`),
                  run.htmlUrl ? h('a', { className: 'dr-link', href: run.htmlUrl, target: '_blank', rel: 'noreferrer' }, '↗') : null,
                ),
                openRunId === run.id
                  ? h(
                      'div',
                      { style: { padding: '4px 0 8px 18px' }, key: `${run.id}-detail` },
                      detailLoading ? h('p', { className: 'dr-muted' }, t('runDetailLoading')) : null,
                      detailError ? h('p', { className: 'dr-muted' }, `${t('runDetailFailed')}: ${detailError}`) : null,
                      detail
                        ? h(
                            'div',
                            null,
                            ...(detail.jobs || []).map((job) =>
                              h(
                                'div',
                                { key: String(job.id), style: { margin: '4px 0 6px' } },
                                h(
                                  'div',
                                  { className: 'dr-row', style: { borderTop: 'none', padding: '2px 0' } },
                                  h('span', { className: `dr-dot ${jobTone(job)}` }),
                                  h('span', { className: 'dr-row-name', title: job.name }, job.name),
                                  h('span', { className: 'dr-row-state' }, job.conclusion || job.status),
                                  job.htmlUrl ? h('a', { className: 'dr-link', href: job.htmlUrl, target: '_blank', rel: 'noreferrer' }, '↗') : null,
                                ),
                                (job.steps && job.steps.length)
                                  ? h(
                                      'div',
                                      { style: { paddingLeft: '14px' } },
                                      ...job.steps.map((step) =>
                                        h(
                                          'div',
                                          { className: 'dr-row', key: `${job.id}-${step.number}`, style: { borderTop: 'none', padding: '1px 0' } },
                                          h('span', { className: `dr-dot ${stepTone(step)}` }),
                                          h('span', { className: 'dr-row-name', title: step.name }, step.name),
                                          h('span', { className: 'dr-row-state' }, step.conclusion || step.status),
                                        ),
                                      ),
                                    )
                                  : h('p', { className: 'dr-muted', style: { paddingLeft: '14px' } }, t('noSteps')),
                              ),
                            ),
                          )
                        : null,
                    )
                  : null,
              ),
            )
          : h('p', { className: 'dr-muted' }, t('runsNone')),
      );
    }

    function LocalReviewsCard({ snapshot, t }) {
      const reviews = snapshot.localReviews ?? [];
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('localReviews'))),
        reviews.length
          ? reviews.map((review) =>
              h(
                'div',
                { className: 'dr-row', key: review.runId },
                h('span', { className: `dr-dot ${review.verdict === 'pass' ? 'ok' : review.verdict === 'block' || review.verdict === 'fail' ? 'bad' : 'warn'}` }),
                h('span', { className: 'dr-row-name', title: review.runId }, review.runId),
                h('span', { className: 'dr-row-state' }, `${t('reviewVerdict')}: ${review.verdict || 'unknown'} · ${interpolate(t('reviewCounts'), review.counts || {})}`),
              ),
            )
          : h('p', { className: 'dr-muted' }, t('localReviewsNone')),
      );
    }

    function SessionsCard({ snapshot, t }) {
      const sessions = snapshot.sessions ?? [];
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('sessions'))),
        sessions.length
          ? sessions.map((session) =>
              h(
                'div',
                { className: 'dr-row', key: session.id },
                h('span', { className: 'dr-dot idle' }),
                h('span', { className: 'dr-row-name', title: session.title || session.id }, session.title || session.id),
                h('span', { className: 'dr-row-state' }, relativeTime(session.updatedAt, t)),
              ),
            )
          : h('p', { className: 'dr-muted' }, t('sessionsNone')),
      );
    }

    function ActionsCard({ snapshot, t, onRefresh, refreshing, projectId }) {
      const links = snapshot.capabilities || {};
      const remote = links.actions || {};
      const project = snapshot.project;
      const [copied, setCopied] = React.useState(false);
      const [pending, setPending] = React.useState('');
      const [toast, setToast] = React.useState(null);
      const headSha = links.headSha || snapshot.github?.pr?.headSha || '';
      const copyBranch = async () => {
        try {
          await navigator.clipboard.writeText(project.branch || '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be unavailable */
        }
      };
      const act = async (name, extra) => {
        if (!headSha) {
          setToast({ tone: 'bad', text: `${t('actionFailed')}：${t('noPullRequest')}` });
          return;
        }
        if (name === 'merge' && !window.confirm(t('mergeConfirm'))) return;
        setPending(name);
        setToast(null);
        try {
          const result = await request(`api/action?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ action: name, headSha, ...(extra || {}) }),
          });
          if (result.ok) {
            setToast({ tone: 'ok', text: result.message || t('actionDone') });
            onRefresh();
          } else {
            setToast({ tone: 'bad', text: `${t('actionFailed')}：${result.message || result.code}` });
          }
        } catch (cause) {
          setToast({ tone: 'bad', text: `${t('actionFailed')}：${String(cause?.message || cause)}` });
        } finally {
          setPending('');
        }
      };
      const remoteButton = (name, label, config) =>
        h(
          'button',
          {
            className: 'dr-btn',
            type: 'button',
            disabled: !config?.enabled || Boolean(pending),
            title: config?.reason || '',
            onClick: () => act(name, name === 'update-branch' ? { method: (config?.methods || ['merge'])[0] } : {}),
          },
          pending === name ? t('actionRunning') : label,
        );
      const blocked = ['rerun', 'markReady', 'updateBranch', 'merge']
        .map((key) => ({ key, config: remote[key] }))
        .filter((entry) => entry.config && !entry.config.enabled && entry.config.reason);
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('next')), h('span', { className: 'dr-spacer' }),
          h('span', { className: 'dr-card-title-sub' }, links.dataSource === 'forge' ? t('dataSourceForge') : t('dataSourceRest'))),
        h(
          'div',
          { className: 'dr-actions' },
          h('button', { className: 'dr-btn primary', type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? h('span', { className: 'dr-spin' }) : null, refreshing ? t('refreshing') : t('refresh')),
          remoteButton('rerun', t('rerunFailed'), remote.rerun),
          remoteButton('mark-ready', t('markReady'), remote.markReady),
          remoteButton('update-branch', t('updateBranch'), remote.updateBranch),
          remoteButton('merge', t('mergePr'), remote.merge),
          links.openPrUrl ? h('a', { className: 'dr-btn', href: links.openPrUrl, target: '_blank', rel: 'noreferrer' }, t('openPullRequest')) : null,
          !links.openPrUrl && links.createPrUrl ? h('a', { className: 'dr-btn', href: links.createPrUrl, target: '_blank', rel: 'noreferrer' }, t('createPullRequest')) : null,
          links.actionsUrl ? h('a', { className: 'dr-btn', href: links.actionsUrl, target: '_blank', rel: 'noreferrer' }, t('openActions')) : null,
          links.openRepoUrl ? h('a', { className: 'dr-btn', href: links.openRepoUrl, target: '_blank', rel: 'noreferrer' }, t('openRepo')) : null,
          project.branch ? h('button', { className: 'dr-btn', type: 'button', onClick: copyBranch }, copied ? t('copied') : t('copyBranch')) : null,
        ),
        toast ? h('div', { className: `dr-notice ${toast.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '8px 0 0' } }, toast.text) : null,
        blocked.length
          ? h(
              'div',
              { style: { marginTop: '8px' }, key: 'blocked' },
              ...blocked.map((entry) => h('p', { className: 'dr-muted', key: entry.key, style: { margin: '1px 0' } }, `· ${entry.config.reason}`)),
            )
          : null,
      );
    }

    function statusTone(status) {
      if (status === 'completed' || status === 'addressed') return 'ok';
      if (status === 'failed' || status === 'critical') return 'bad';
      if (status === 'running') return 'run';
      if (status === 'blocked' || status === 'warning') return 'warn';
      return 'idle';
    }

    function AnnotationsCard({ snapshot, t, projectId, onRefresh, onAskAgent }) {
      const annotations = snapshot.annotations || [];
      const [form, setForm] = React.useState({ file: '', startLine: '', endLine: '', body: '', severity: 'warning' });
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const change = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      const post = async (payload) => {
        setBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/annotations?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          if (!result.ok) {
            setMessage({ tone: 'bad', text: result.message || 'failed' });
          } else {
            setMessage({ tone: 'ok', text: t('annotationSaved') });
            if (payload.action === 'create') setForm({ file: '', startLine: '', endLine: '', body: '', severity: 'warning' });
            onRefresh();
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setBusy(false);
        }
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('annotations')), h('span', { className: 'dr-spacer' }),
          h('span', { className: 'dr-card-title-sub' }, `${annotations.length}`)),
        h('p', { className: 'dr-muted', style: { marginBottom: '8px' } }, t('annotationsHelp')),
        annotations.length
          ? h(
              'div',
              null,
              ...annotations.map((annotation) =>
                h(
                  'div',
                  { className: 'dr-row', key: annotation.id, style: { alignItems: 'flex-start', flexDirection: 'column', gap: '3px' } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center', width: '100%' } },
                    h('span', { className: `dr-dot ${statusTone(annotation.severity)}` }),
                    h('span', { className: 'dr-code' }, `${annotation.file}:${annotation.startLine}${annotation.endLine ? `-${annotation.endLine}` : ''}`),
                    h('span', { className: 'dr-row-state' }, annotation.status === 'open' ? t('annotationOpen') : annotation.status === 'addressed' ? t('annotationAddressed') : t('annotationWontfix')),
                    h('span', { className: 'dr-spacer' }),
                    h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => onAskAgent(annotation) }, t('annotationAskAgent')),
                    h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => post({ action: 'update', id: annotation.id, status: annotation.status === 'open' ? 'addressed' : 'open' }) }, annotation.status === 'open' ? t('annotationMarkAddressed') : t('annotationMarkOpen')),
                    h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => post({ action: 'delete', id: annotation.id }) }, t('annotationDelete')),
                  ),
                  h('div', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap' } }, annotation.body),
                ),
              ),
            )
          : h('p', { className: 'dr-muted' }, t('annotationsNone')),
        h(
          'div',
          { style: { borderTop: '1px dashed var(--dsw-alias-border-l1,#e5e7eb)', paddingTop: '10px', marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
          h('input', { className: 'dr-input', placeholder: `${t('annotationFile')} (${t('annotationFileExample')})`, value: form.file, onChange: change('file'), style: { minWidth: '180px', flex: 1 } }),
          h('input', { className: 'dr-input', placeholder: t('annotationLine'), value: form.startLine, onChange: change('startLine'), style: { width: '72px' } }),
          h('input', { className: 'dr-input', placeholder: t('annotationEndLine'), value: form.endLine, onChange: change('endLine'), style: { width: '92px' } }),
          h('select', { className: 'dr-input', value: form.severity, onChange: change('severity') },
            h('option', { value: 'info' }, t('severityInfo')),
            h('option', { value: 'warning' }, t('severityWarning')),
            h('option', { value: 'critical' }, t('severityCritical')),
          ),
          h('input', { className: 'dr-input', placeholder: t('annotationBody'), value: form.body, onChange: change('body'), style: { minWidth: '260px', flex: 2 } }),
          h('button', { className: 'dr-btn primary', type: 'button', disabled: busy, onClick: () => post({ action: 'create', ...form }) }, t('annotationAdd')),
        ),
        message ? h('div', { className: `dr-notice ${message.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '8px 0 0' } }, message.text) : null,
      );
    }

    function reportLines(report, t) {
      const changes = Array.isArray(report?.changes) ? report.changes : [];
      const consequences = report?.consequences && typeof report.consequences === 'object' ? report.consequences : {};
      const tests = report?.tests && typeof report.tests === 'object' ? report.tests : {};
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        report?.summary ? h('div', { style: { whiteSpace: 'pre-wrap' } }, report.summary) : null,
        changes.length
          ? h('div', null, h('div', { className: 'dr-muted' }, t('agentChanges')), ...changes.map((change, index) =>
              h('div', { key: index, className: 'dr-muted', style: { paddingLeft: '10px' } },
                `${change.file ?? '?'} ${Array.isArray(change.locations) ? change.locations.join(', ') : ''} · ${change.risk?.level ?? ''}`,
                change.summary ? ` — ${change.summary}` : '',
              )))
          : null,
        Object.keys(consequences).length
          ? h('div', null, h('div', { className: 'dr-muted' }, t('agentConsequences')), ...Object.entries(consequences).map(([key, value]) =>
              value ? h('div', { key, className: 'dr-muted', style: { paddingLeft: '10px' } }, `${key}: ${value}`) : null))
          : null,
        h('div', { className: 'dr-muted' },
          `${t('agentTests')} · ${t('agentTestsPlanned')}: ${Array.isArray(tests.planned) ? tests.planned.length : 0} · ${t('agentTestsExecuted')}: ${Array.isArray(tests.executed) ? tests.executed.length : 0} · ${t('agentTestsNotRun')}: ${Array.isArray(tests.notRun) ? tests.notRun.length : 0}`),
        Array.isArray(tests.executed) && tests.executed.length
          ? h('div', null, ...tests.executed.map((item, index) => h('div', { key: index, className: 'dr-muted', style: { paddingLeft: '10px' } }, `${item.command ?? ''} → exit ${item.exitCode ?? '?'}`)))
          : null,
        Array.isArray(report?.unresolved) && report.unresolved.length
          ? h('div', null, h('div', { className: 'dr-muted' }, t('agentUnresolved')), ...report.unresolved.map((item, index) => h('div', { key: index, className: 'dr-muted', style: { paddingLeft: '10px' } }, String(item))))
          : null,
        Array.isArray(report?.nextSteps) && report.nextSteps.length
          ? h('div', null, h('div', { className: 'dr-muted' }, t('agentNextSteps')), ...report.nextSteps.map((item, index) => h('div', { key: index, className: 'dr-muted', style: { paddingLeft: '10px' } }, String(item))))
          : null,
      );
    }

    function AgentTasksCard({ snapshot, t, projectId, draft, onClearDraft, onRefresh }) {
      const tasks = snapshot.agentTasks || [];
      const [instruction, setInstruction] = React.useState('');
      const [targetFile, setTargetFile] = React.useState('');
      const [targetLine, setTargetLine] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      React.useEffect(() => {
        if (draft) {
          setInstruction(draft.instruction || '');
          setTargetFile(draft.file || '');
          setTargetLine(draft.startLine ? String(draft.startLine) : '');
        }
      }, [draft]);
      const start = async () => {
        if (!instruction.trim()) {
          setMessage({ tone: 'bad', text: t('agentNoInstruction') });
          return;
        }
        setBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/agent-task?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({
              instruction,
              annotationId: draft?.annotationId ?? null,
              riskBudget: draft?.riskBudget ?? 'low',
              target: targetFile.trim()
                ? { file: targetFile.trim(), startLine: Number(targetLine) > 0 ? Number(targetLine) : 1 }
                : null,
            }),
          });
          if (result.ok) {
            setMessage({ tone: 'ok', text: `${t('agentStarted')} · ${result.task.childId ?? ''}` });
            setInstruction('');
            onClearDraft();
            onRefresh();
          } else {
            setMessage({ tone: 'bad', text: `${t('agentStartFailed')}：${result.message || ''}` });
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: `${t('agentStartFailed')}：${String(cause?.message || cause)}` });
        } finally {
          setBusy(false);
        }
      };
      const cancel = async (taskId) => {
        setBusy(true);
        try {
          await request(`api/agent-task/cancel?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: JSON.stringify({ taskId }) });
          onRefresh();
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setBusy(false);
        }
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('agentTasks')), h('span', { className: 'dr-spacer' }),
          h('span', { className: 'dr-card-title-sub' }, `${tasks.length}`)),
        h('p', { className: 'dr-muted', style: { marginBottom: '4px' } }, t('agentTasksExplain')),
        h('p', { className: 'dr-muted', style: { marginBottom: '8px' } }, t('agentTasksFlow')),
        h(
          'div',
          { style: { marginBottom: '10px', border: '1px solid #d5dbe3', borderRadius: '8px', padding: '10px', background: '#f8fafc' } },
          h('p', { className: 'dr-muted', style: { margin: '0 0 4px', color: '#1f2328', fontWeight: '600' } }, draft ? `${t('agentDraftTitle')} · ${t('agentTarget')}: ${draft.target || ''}` : t('agentDraftTitle')),
          h('p', { className: 'dr-muted', style: { margin: '0 0 8px' } }, t('agentDraftHint')),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' } },
            h('input', {
              className: 'dr-input',
              placeholder: `${t('annotationFile')} (${t('annotationFileExample')})`,
              value: targetFile,
              onChange: (event) => setTargetFile(event.target.value),
              style: { flex: 2, minWidth: '200px' },
            }),
            h('input', {
              className: 'dr-input',
              placeholder: t('annotationLine'),
              value: targetLine,
              onChange: (event) => setTargetLine(event.target.value),
              style: { width: '96px' },
            }),
          ),
          h('textarea', {
            className: 'dr-input dr-textarea',
            value: instruction,
            onChange: (event) => setInstruction(event.target.value),
            placeholder: t('agentInstruction'),
            rows: 3,
            style: { width: '100%', boxSizing: 'border-box' },
          }),
          h(
            'div',
            { className: 'dr-actions', style: { marginTop: '6px' } },
            h('button', { className: 'dr-btn primary', type: 'button', disabled: busy, onClick: start }, busy ? t('agentStarting') : t('agentStart')),
            draft
              ? h('button', {
                  className: 'dr-btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => {
                    setInstruction('');
                    setTargetFile('');
                    setTargetLine('');
                    onClearDraft();
                  },
                }, t('agentCancel'))
              : null,
          ),
        ),
        message ? h('div', { className: `dr-notice ${message.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '0 0 8px' } }, message.text) : null,
        tasks.length
          ? h(
              'div',
              null,
              ...tasks.map((task) =>
                h(
                  'div',
                  { key: task.id, style: { borderTop: '1px dashed var(--dsw-alias-border-l1,#e5e7eb)', paddingTop: '8px', marginTop: '8px' } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    h(Badge, { tone: statusTone(task.status) }, task.status === 'running' ? t('agentStatusRunning') : task.status === 'completed' ? t('agentStatusCompleted') : task.status === 'blocked' ? t('agentStatusBlocked') : task.status === 'cancelled' ? t('agentStatusCancelled') : t('agentStatusFailed')),
                    h('span', { className: 'dr-code' }, task.id),
                    task.childId ? h('span', { className: 'dr-row-state' }, `${t('agentChildSession')}: ${task.childId}`) : null,
                    h('span', { className: 'dr-spacer' }),
                    task.status === 'running' ? h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => cancel(task.id) }, t('agentCancel')) : null,
                  ),
                  h('div', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, task.instruction),
                  task.error ? h('div', { className: 'dr-notice dr-error', style: { margin: '4px 0' } }, task.error) : null,
                  task.report ? reportLines(task.report, t) : null,
                ),
              ),
            )
          : h('p', { className: 'dr-muted' }, t('agentTasksNone')),
      );
    }

    function ProjectList({ projects, selectedId, onSelect, t }) {
      return h(
        'div',
        { className: 'dr-list' },
        h('div', { className: 'dr-list-head' }, t('projects')),
        projects.map((project) =>
          h(
            'button',
            {
              key: project.id,
              type: 'button',
              className: 'dr-project',
              'data-active': String(project.id === selectedId),
              title: project.root,
              onClick: () => onSelect(project.id),
            },
            h(
              'span',
              { className: 'dr-project-name' },
              h('span', { className: `dr-dot ${project.exists && project.git ? (project.dirty > 0 ? 'warn' : 'ok') : 'bad'}` }),
              project.name,
            ),
            h('span', { className: 'dr-project-meta' }, project.branch || t('noHead'), project.repo ? ` · ${project.repo}` : ''),
          ),
        ),
      );
    }

    function Page({ locale }) {
      const [lang, setLang] = React.useState('zh');
      const t = React.useCallback((key, params) => {
        const dict = DICT[lang] || DICT.zh;
        const template = dict[key] ?? DICT.zh[key] ?? key;
        return params ? interpolate(template, params) : template;
      }, [lang]);
      const model = useWorkbench(t);
      const snapshot = model.snapshot;
      const [agentDraft, setAgentDraft] = React.useState(null);
      return h(
        'div',
        { className: 'dr-root' },
        h('style', { key: 'ci-review-css' }, CSS),
        h(
          'details',
          { className: 'dr-help', style: { margin: '10px 18px 0' } },
          h('summary', { style: { cursor: 'pointer', fontWeight: '600', fontSize: '13px' } }, t('helpTitle')),
          h('p', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap', margin: '8px 0 0', lineHeight: '1.6' } }, t('helpText')),
        ),
        h(
          'header',
          { className: 'dr-header' },
          h('div', { className: 'dr-headline' }, h('h1', { className: 'dr-title' }, t('title')), h('p', { className: 'dr-subtitle' }, t('subtitle'))),
          h(
            'div',
            { className: 'dr-header-right' },
            h(Badge, { tone: snapshot?.github?.available ? 'ok' : 'warn' }, snapshot?.capabilities?.dataSource === 'forge' ? t('dataSourceForge') : snapshot?.github?.available ? t('dataSourceRest') : t('githubMissing')),
            h('button', { className: 'dr-btn', type: 'button', onClick: () => setLang(lang === 'zh' ? 'en' : 'zh'), title: 'Language / 语言' }, lang === 'zh' ? 'EN' : '中文'),
            model.updatedAt ? h('span', { className: 'dr-row-state' }, interpolate(t('updated'), { time: new Date(model.updatedAt).toLocaleTimeString() })) : null,
            h('button', { className: 'dr-btn', type: 'button', onClick: model.refresh, disabled: model.refreshing || !model.selectedId }, model.refreshing ? t('refreshing') : t('refresh')),
          ),
        ),
        model.error
          ? h('div', { className: 'dr-notice dr-error', style: { margin: '12px 18px 0' } }, model.error, ' ', h('button', { className: 'dr-btn', type: 'button', onClick: model.retry }, t('retry')))
          : null,
        model.projects.length === 0 && !model.loading
          ? h(
              'div',
              { className: 'dr-empty' },
              h('p', null, t('noProjects')),
              h('p', { className: 'dr-muted' }, t('noProjectsHint')),
            )
          : h(
              'div',
              { className: 'dr-body' },
              h(ProjectList, { projects: model.projects, selectedId: model.selectedId, onSelect: model.selectProject, t }),
              h(
                'main',
                { className: 'dr-main' },
                model.loading && !snapshot ? h('p', { className: 'dr-muted' }, t('loading')) : null,
                snapshot
                  ? h(
                      React.Fragment,
                      null,
                      h(SummaryCard, { snapshot, t }),
                      h(GitHubNotice, { snapshot, t }),
                      h(PrCard, { snapshot, t }),
                      h(RunsCard, { snapshot, t, projectId: snapshot.project.id }),
                      h(LocalReviewsCard, { snapshot, t }),
                      h(SessionsCard, { snapshot, t }),
                      h(AnnotationsCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        onRefresh: model.refresh,
                        onAskAgent: (annotation) => setAgentDraft({
                          annotationId: annotation.id,
                          target: `${annotation.file}:${annotation.startLine}${annotation.endLine ? `-${annotation.endLine}` : ''}`,
                          file: annotation.file,
                          startLine: annotation.startLine,
                          instruction: `修复这条批注指出的问题：${annotation.body}\n\n范围：${annotation.file}:${annotation.startLine}${annotation.endLine ? `-${annotation.endLine}` : ''}`,
                          riskBudget: annotation.severity === 'critical' ? 'medium' : 'low',
                        }),
                      }),
                      h(AgentTasksCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        draft: agentDraft,
                        onClearDraft: () => setAgentDraft(null),
                        onRefresh: model.refresh,
                      }),
                      h(ActionsCard, { snapshot, t, onRefresh: model.refresh, refreshing: model.refreshing, projectId: snapshot.project.id }),
                      h(
                        'div',
                        { className: 'dr-footer' },
                        h('span', { className: 'dr-path' }, snapshot.project.root),
                        snapshot.project.remote ? h('span', { className: 'dr-path' }, snapshot.project.remote) : null,
                        h('span', null, interpolate(t('generatedAt'), { time: new Date(snapshot.generatedAt).toLocaleTimeString() })),
                      ),
                    )
                  : null,
              ),
            ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const localeService = ctx.locale;
        try {
          localeService?.register?.('ci-review', 'zh-CN', DICT.zh);
        } catch {
          /* another mount may have registered it already */
        }
        try {
          localeService?.register?.('ci-review', 'en', DICT.en);
        } catch {
          /* another mount may have registered it already */
        }
        let t;
        try {
          const bound = localeService?.bind?.('ci-review');
          if (typeof bound === 'function') {
            t = (key, params) => {
              const template = bound(key) || key;
              return params ? interpolate(template, params) : template;
            };
          }
        } catch {
          /* fall back to the local dictionary */
        }
        if (!t) {
          let localeId = 'en';
          try {
            localeId = localeService?.getLocale?.()?.id || 'en';
          } catch {
            localeId = 'en';
          }
          const dict = /^zh/i.test(localeId) ? DICT.zh : DICT.en;
          t = (key, params) => interpolate(dict[key] ?? key, params);
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'ci-review', order: 15, label: () => t('panelLabel') },
            function CiReviewIcon(owner) {
              return h(Icon, { size: owner?.size || 20 });
            },
          ),
        );
        const PageWithLocale = () => h(Page, { locale: t });
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'ci-review' }, PageWithLocale),
        );
      },
    };
  },
});
