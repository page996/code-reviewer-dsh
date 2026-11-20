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

    const clientServices = { sessions: null, uiWorkspace: null };

    const DICT = {      zh: {
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
        reviewCards: '审阅卡（按问题分批）',
        reviewCardsNone: '还没有可审阅的问题批次。',
        reviewCardsBatch: '第 {n} / {total} 批 · {severity} · {files} 个文件',
        reviewCardsModules: '涉及模块',
        reviewCardsCoverage: '覆盖：{findings} 条发现 / {files} 个文件 / 类别 {categories}',
        reviewCardsApprove: '通过（进入待修复队列）',
        reviewCardsRevision: '需修订',
        reviewCardsIgnore: '忽略',
        reviewCardsApproveBatch: '整批通过',
        reviewCardsIgnoreBatch: '整批忽略',
        reviewCardsShowLow: '显示低优先级批次',
        reviewCardsHideLow: '收起低优先级批次',
        reviewCardsExcerpt: '源码片段',
        reviewCardsUncertainty: '不确定点',
        fixQueue: '待修复队列',
        fixQueueNone: '还没有进入待修复队列的问题。审阅卡点「通过」后会出现在这里。',
        fixQueueStatusQueued: '待修复',
        fixQueueStatusStarted: '修复中',
        fixQueueStatusFixed: '已修复',
        fixQueueStatusVerified: '已验证',
        fixQueueStart: '让 Agent 修复',
        fixQueueMarkFixed: '标记已修复',
        fixQueueRemove: '移出队列',
        sourceLabel: '来源',
        vscodeLive: 'VS Code 实时缓冲区',
        vscodeLiveDirty: 'VS Code 实时缓冲区（未保存）',
        diskSource: '磁盘内容（L1）',
        copyBridge: '复制桥接参数',
        bridgeCopied: '已复制',
        prCommentHere: 'PR 行内评论',
        approvePr: 'Approve',
        requestChanges: 'Request changes',
        commentPr: 'Comment',
        requestChangesPrompt: '填写要求修改的说明（必须）',
        commentPrompt: '填写 PR 评论内容',
        prComments: 'PR 行内评论',
        connectVscode: '连接 VS Code',
        connectRequested: '已唤起 VS Code',
        unchangedLines: '与磁盘一致',
        unsavedLines: '未保存修改 {count} 行（相对磁盘）',
        taskDiff: '查看改动 diff',
        taskDiffHide: '收起 diff',
        openInVscode: '在 VS Code 打开',
        agentOpenSession: '打开子会话',
        agentSessionHint: '子会话是 DSH 中真实的后台会话，可打开后继续聊天/追问。',
        agentShowMessages: '查看对话',
        agentHideMessages: '收起对话',
        agentMessagesEmpty: '子会话还没有可展示的消息。',
        agentFollowUp: '继续对话 / 追问这个子会话',
        agentFollowUpPlaceholder: '输入要发给子会话的消息，例如：只读检查 lib/llm.js:100 附近的问题，不要改文件',
        agentSend: '发送到子会话',
        agentSent: '已发送',
        addProject: '添加项目',
        projectPathPlaceholder: '项目根目录，如 C:\\work\\my-repo',
        fileReview: '文件与问题',
        editFile: '编辑文件',
        saveEdit: '保存并跑 gate',
        cancelEdit: '取消编辑',
        savedOk: '已保存，gate 通过',
        savedFail: '已保存，但 gate 失败',
        unsavedConflict: '文件已在磁盘上被修改，已重新加载最新内容，请重新编辑',
        vscodeDirtyBlock: 'VS Code 有未保存缓冲区，请先在 VS Code 保存后再在面板编辑',
        filesPriority: '优先文件',
        filesAll: '全部文件',
        filesNone: '还没有发现/批注/PR 改动文件。',
        filesPick: '从左侧选择文件，或点下面的发现直接定位。',
        filesLoading: '读取文件…',
        fileTooLarge: '文件超过 400KB，暂不展示内容（可到 GitHub 查看）。',
        fileFindings: '该文件的问题',
        askAgentHere: '让 Agent 修订此处',
        annotateHere: '在这里批注',
        copyPosition: '复制位置',
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
        reviewCards: 'Review cards (problem batches)',
        reviewCardsNone: 'No review batch yet.',
        reviewCardsBatch: 'Batch {n} / {total} · {severity} · {files} file(s)',
        reviewCardsModules: 'Modules',
        reviewCardsCoverage: 'Coverage: {findings} findings / {files} files / categories {categories}',
        reviewCardsApprove: 'Approve (queue for fix)',
        reviewCardsRevision: 'Needs revision',
        reviewCardsIgnore: 'Ignore',
        reviewCardsApproveBatch: 'Approve batch',
        reviewCardsIgnoreBatch: 'Ignore batch',
        reviewCardsShowLow: 'Show low-priority batches',
        reviewCardsHideLow: 'Hide low-priority batches',
        reviewCardsExcerpt: 'Source excerpt',
        reviewCardsUncertainty: 'Uncertainty',
        fixQueue: 'Fix queue',
        fixQueueNone: 'No approved problem queued yet. Approve a review card to add it here.',
        fixQueueStatusQueued: 'queued',
        fixQueueStatusStarted: 'fix started',
        fixQueueStatusFixed: 'fixed',
        fixQueueStatusVerified: 'verified',
        fixQueueStart: 'Ask agent to fix',
        fixQueueMarkFixed: 'Mark fixed',
        fixQueueRemove: 'Remove from queue',
        sourceLabel: 'Source',
        vscodeLive: 'VS Code live buffer',
        vscodeLiveDirty: 'VS Code live buffer (unsaved)',
        diskSource: 'Disk content (L1)',
        copyBridge: 'Copy bridge settings',
        bridgeCopied: 'Copied',
        prCommentHere: 'PR inline comment',
        approvePr: 'Approve',
        requestChanges: 'Request changes',
        commentPr: 'Comment',
        requestChangesPrompt: 'Describe the required changes (required)',
        commentPrompt: 'PR comment text',
        prComments: 'PR inline comments',
        connectVscode: 'Connect VS Code',
        connectRequested: 'VS Code requested',
        unchangedLines: 'matches disk',
        unsavedLines: '{count} unsaved line(s) vs disk',
        taskDiff: 'Show diff',
        taskDiffHide: 'Hide diff',
        openInVscode: 'Open in VS Code',
        agentOpenSession: 'Open child session',
        agentSessionHint: 'The child session is a real DSH session; open it to keep chatting or asking follow-ups.',
        agentShowMessages: 'Show conversation',
        agentHideMessages: 'Hide conversation',
        agentMessagesEmpty: 'The child session has no messages to show yet.',
        agentFollowUp: 'Continue the conversation with this child session',
        agentFollowUpPlaceholder: 'Message to the child session, e.g. inspect lib/llm.js:100 read-only, do not edit files',
        agentSend: 'Send to child session',
        agentSent: 'Sent',
        addProject: 'Add project',
        projectPathPlaceholder: 'Project root, e.g. C:\\work\\my-repo',
        fileReview: 'Files & findings',
        fileReviewHint: 'See the file first, then decide what to change',
        editFile: 'Edit file',
        saveEdit: 'Save and run gate',
        cancelEdit: 'Cancel edit',
        savedOk: 'Saved; gate passed',
        savedFail: 'Saved; gate failed',
        unsavedConflict: 'File changed on disk; reloaded the latest content, please edit again',
        vscodeDirtyBlock: 'VS Code has unsaved changes; save in VS Code before editing here',
        filesPriority: 'Priority files',
        filesAll: 'All files',
        filesNone: 'No finding, annotation or PR-changed file yet.',
        filesPick: 'Pick a file on the left, or click a finding below to jump to it.',
        filesLoading: 'Loading file…',
        fileTooLarge: 'This file is over 400KB; its content is not shown.',
        fileFindings: 'Findings in this file',
        askAgentHere: 'Ask agent to fix here',
        annotateHere: 'Annotate here',
        copyPosition: 'Copy position',
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
@media (max-width:760px){.dr-body{grid-template-columns:1fr}.dr-list{border-right:none;border-bottom:1px solid #23262d;max-height:180px}}
/* Dark unified surface: every box is near-black with white text. */
.dr-root{background:#08090c;color:#f5f7fa}
.dr-header{border-bottom:1px solid #23262d}
.dr-subtitle{color:#9aa3b2}
.dr-badge{background:#111318;border-color:#2a2e37;color:#c8d0dc}
.dr-badge strong{color:#f5f7fa}
.dr-list{border-right-color:#23262d}
.dr-list-head{color:#9aa3b2}
.dr-project:hover{background:#14171d}
.dr-project[data-active="true"]{background:#1b1f27;border-color:#343a46}
.dr-project-meta{color:#9aa3b2}
.dr-card{background:#0f1116;border-color:#23262d}
.dr-card-title{color:#f5f7fa}
.dr-card-title-sub{color:#9aa3b2}
.dr-muted{color:#9aa3b2}
.dr-row{border-top-color:#1f232b}
.dr-row-state{color:#9aa3b2}
.dr-input{background:#050608;color:#f5f7fa;border-color:#343a46}
.dr-input::placeholder{color:#6f7987}
.dr-input:focus{outline-color:#2f81f7}
.dr-link,.dr-btn.dr-link{color:#6cb6ff}
.dr-btn{background:#1b2029;color:#f5f7fa;border-color:#3a4150}
.dr-btn:hover:not(:disabled){background:#242b37;border-color:#48505f}
.dr-btn:disabled{background:#12151b;color:#66707e;border-color:#282e38}
.dr-btn.primary{background:#2f81f7;border-color:#2f81f7;color:#ffffff}
.dr-btn.primary:hover:not(:disabled){background:#1f6feb;border-color:#1f6feb}
.dr-notice{background:#141821;border-color:#2a303a;border-left-color:#d29922;color:#e8edf4}
.dr-error{border-left-color:#f85149}
.dr-empty{color:#9aa3b2}
.dr-code{background:#161a21;border-color:#2a303a;color:#e6edf3}
.dr-path,.dr-footer{color:#9aa3b2}
.dr-spin{border-color:#3a4150;border-top-color:#2f81f7}
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
      const [selectedId, setSelectedId] = React.useState(() => {
        try {
          return localStorage.getItem('ciReview:project') || '';
        } catch {
          return '';
        }
      });
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
        if (!selectedId) return;
        try {
          localStorage.setItem('ciReview:project', selectedId);
        } catch {
          /* storage may be unavailable */
        }
      }, [selectedId]);

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
        addProject: async (root) => {
          const result = await request('api/projects/add', { method: 'POST', body: JSON.stringify({ root }) });
          if (!result.ok) throw new Error(result.message || 'add failed');
          await loadProjects();
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

    function PrCard({ snapshot, t, projectId, onRefresh }) {
      const github = snapshot.github;
      const pr = github?.pr;
      const links = snapshot.capabilities || {};
      const [reviewBusy, setReviewBusy] = React.useState('');
      const [reviewMessage, setReviewMessage] = React.useState(null);
      const submitReview = async (event, body) => {
        setReviewBusy(event);
        setReviewMessage(null);
        try {
          const result = await request(`api/pr/review?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ event, body }),
          });
          setReviewMessage(result.ok
            ? { tone: 'ok', text: `PR review 已提交：${event}` }
            : { tone: 'bad', text: result.message || 'review failed' });
          if (result.ok) onRefresh();
        } catch (cause) {
          setReviewMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setReviewBusy('');
        }
      };
      const mergePullRequest = async () => {
        if (!window.confirm('确认用 squash 合并该 PR？此操作会改变远端仓库。')) return;
        setReviewBusy('MERGE');
        setReviewMessage(null);
        try {
          const result = await request(`api/pr/merge?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ method: 'squash' }),
          });
          setReviewMessage(result.ok
            ? { tone: 'ok', text: 'PR 已合并（squash）' }
            : { tone: 'bad', text: result.message || 'merge failed' });
          if (result.ok) onRefresh();
        } catch (cause) {
          setReviewMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setReviewBusy('');
        }
      };
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
          'div',
          { className: 'dr-actions', style: { marginBottom: '8px' } },
          h('button', { className: 'dr-btn primary', type: 'button', disabled: Boolean(reviewBusy), onClick: () => submitReview('APPROVE', '') }, reviewBusy === 'APPROVE' ? '…' : t('approvePr')),
          h('button', { className: 'dr-btn', type: 'button', disabled: Boolean(reviewBusy), onClick: () => { const body = window.prompt(t('requestChangesPrompt')); if (body && body.trim()) submitReview('REQUEST_CHANGES', body.trim()); } }, t('requestChanges')),
          h('button', { className: 'dr-btn', type: 'button', disabled: Boolean(reviewBusy), onClick: () => { const body = window.prompt(t('commentPrompt')); if (body && body.trim()) submitReview('COMMENT', body.trim()); } }, t('commentPr')),
          h('button', { className: 'dr-btn', type: 'button', disabled: Boolean(reviewBusy), onClick: mergePullRequest }, reviewBusy === 'MERGE' ? '…' : t('mergePr')),
        ),
        reviewMessage ? h('div', { className: `dr-notice ${reviewMessage.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '0 0 8px' } }, reviewMessage.text) : null,
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

    function bufferFor(snapshot, file) {
      try {
        const bridge = snapshot?.vscode;
        if (!bridge || !bridge.connected) return null;
        const direct = bridge.buffers?.[file];
        if (direct && Array.isArray(direct.lines)) return direct;
        const normalized = String(file ?? '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
        if (!normalized) return null;
        for (const buffer of Object.values(bridge.buffers ?? {})) {
          if (!buffer || !Array.isArray(buffer.lines)) continue;
          const abs = String(buffer.absPath ?? buffer.file ?? '').replace(/\\/g, '/').toLowerCase();
          if (abs.endsWith(`/${normalized}`) || abs === normalized) return buffer;
        }
        return null;
      } catch {
        return null;
      }
    }

    function statusTone(status) {
      if (status === 'completed' || status === 'addressed') return 'ok';
      if (status === 'failed' || status === 'critical') return 'bad';
      if (status === 'running') return 'run';
      if (status === 'blocked' || status === 'warning') return 'warn';
      return 'idle';
    }

    function ReviewCardsCard({ snapshot, t, projectId, onRefresh, onAskAgentAt }) {
      const batches = snapshot.reviewBatches || [];
      const [showLow, setShowLow] = React.useState(false);
      const [index, setIndex] = React.useState(() => {
        try {
          return Number(localStorage.getItem(`ciReview:batch:${projectId}`)) || 0;
        } catch {
          return 0;
        }
      });
      React.useEffect(() => {
        try {
          localStorage.setItem(`ciReview:batch:${projectId}`, String(index));
        } catch {
          /* storage may be unavailable */
        }
      }, [projectId, index]);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const visible = batches.filter((batch) => showLow || !batch.collapsed);
      const current = visible[Math.min(index, Math.max(0, visible.length - 1))];
      const decide = async (cardIds, status, cards) => {
        setBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/review-cards/decide?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ cardIds, status, cards: cards ?? undefined, problemId: current?.problemId }),
          });
          if (!result.ok) setMessage({ tone: 'bad', text: result.message || 'failed' });
          else {
            setMessage({ tone: 'ok', text: status === 'approved' ? '已加入待修复队列' : `已标记 ${status}` });
            onRefresh();
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setBusy(false);
        }
      };
      const [worktree, setWorktree] = React.useState(null);
      const [wtBusy, setWtBusy] = React.useState(false);
      const [verifyBusy, setVerifyBusy] = React.useState(false);
      const [batchReviewBusy, setBatchReviewBusy] = React.useState(false);
      const [auditBusy, setAuditBusy] = React.useState(false);
      const startBatchReview = async () => {
        const files = (snapshot.priorityFiles || []).slice(0, 3).map((entry) => entry.path).filter(Boolean);
        if (files.length === 0) {
          setMessage({ tone: 'bad', text: '没有优先文件可评审' });
          return;
        }
        setBatchReviewBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/review-job/start-batch?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ files, lenses: ['correctness', 'errors'] }),
          });
          setMessage(result.ok
            ? { tone: 'ok', text: `已启动 ${result.jobs.filter((job) => job.id).length} 个文件的多视角评审（${files.join(', ')}）` }
            : { tone: 'bad', text: result.message || 'batch review failed' });
          if (result.ok) onRefresh();
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setBatchReviewBusy(false);
        }
      };
      const runAudit = async () => {
        setAuditBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/review/audit?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' });
          setMessage(result.ok
            ? { tone: 'ok', text: '完整性审计已启动（独立 Agent），完成后显示结论' }
            : { tone: 'bad', text: result.message || 'audit failed' });
          if (result.ok) onRefresh();
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setAuditBusy(false);
        }
      };
      const verifyProblem = async () => {
        if (!current) return;
        const firstCard = (current.cards || [])[0] ?? {};
        setVerifyBusy(true);
        setMessage(null);
        try {
          const result = await request(`api/review-problems/verify?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({
              problem: {
                id: current.problemId ?? current.id,
                file: firstCard.file,
                startLine: firstCard.startLine,
                severity: current.severity,
                category: current.category,
                title: current.title,
                problem: current.explanation?.what ?? '',
                evidence: current.explanation?.evidence ?? '',
              },
            }),
          });
          if (result.ok) {
            setMessage({ tone: 'ok', text: '已启动独立 Agent 验证，完成后自动刷新结果' });
            onRefresh();
          } else {
            setMessage({ tone: 'bad', text: result.message || 'verify failed' });
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setVerifyBusy(false);
        }
      };
      const createWorktree = async () => {
        if (!current) return;
        setWtBusy(true);
        setMessage(null);
        try {
          const cards = (current.cards || []).map((cardItem) => ({
            id: cardItem.id, file: cardItem.file, startLine: cardItem.startLine,
            title: cardItem.title, reason: cardItem.problem,
          }));
          const result = await request(`api/review-worktree/create?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ name: current.problemId || current.id, cards }),
          });
          if (result.ok) {
            setWorktree(result);
            setMessage({ tone: 'ok', text: `审阅 worktree 已就绪：${result.path}` });
          } else {
            setMessage({ tone: 'bad', text: result.message || 'worktree failed' });
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setWtBusy(false);
        }
      };
      const removeWorktree = async () => {
        if (!worktree?.path) return;
        setWtBusy(true);
        try {
          const name = String(worktree.path).split(/[\\/]/).pop();
          const result = await request(`api/review-worktree/remove?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ name }),
          });
          if (result.ok) {
            setWorktree(null);
            setMessage({ tone: 'ok', text: '审阅 worktree 已清理' });
          } else {
            setMessage({ tone: 'bad', text: result.message || 'cleanup failed' });
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setWtBusy(false);
        }
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' },
          h('h3', { className: 'dr-card-title' }, t('reviewCards')),
          h('span', { className: 'dr-card-title-sub' }, `${batches.length} 批`),
          h('span', { className: 'dr-spacer' }),
          h('button', { className: 'dr-btn', type: 'button', onClick: () => setShowLow(!showLow) }, showLow ? t('reviewCardsHideLow') : t('reviewCardsShowLow'))),
        visible.length === 0
          ? h('p', { className: 'dr-muted' }, t('reviewCardsNone'))
          : h(
              'div',
              null,
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } },
                h('button', { className: 'dr-btn', type: 'button', disabled: index <= 0, onClick: () => setIndex(index - 1) }, '←'),
                h('button', { className: 'dr-btn', type: 'button', disabled: index >= visible.length - 1, onClick: () => setIndex(index + 1) }, '→'),
                h('span', { className: 'dr-muted' }, `第 ${current.index} / ${visible.length} 批`)),
              h('div', { className: 'dr-card', style: { borderColor: '#3a4150', marginBottom: '8px' } },
                h('div', { className: 'dr-card-head' },
                  h(Badge, { tone: current.severity === 'blocker' ? 'bad' : current.severity === 'major' ? 'warn' : 'run' }, current.severity),
                  h('span', { className: 'dr-card-title' }, current.title),
                  h('span', { className: 'dr-spacer' })),
                current.explanation
                  ? h('div', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap', marginBottom: '6px' } },
                      `发生了什么：${current.explanation.what || '-'}\n为什么重要：${current.explanation.whyImportant || '-'}\n证据：${current.explanation.evidence || '-'}${current.explanation.uncertainty ? `\n不确定点：${current.explanation.uncertainty}` : ''}`)
                  : null,
                h('div', { className: 'dr-muted', style: { marginBottom: '6px' } }, `${t('reviewCardsModules')}: ${(current.modules || []).join(', ') || '-'} · ${t('reviewCardsCoverage').replace('{findings}', current.coverage?.findings ?? 0).replace('{files}', (current.coverage?.files || []).length).replace('{categories}', (current.coverage?.categories || []).join('/'))}`),
                current.verification
                  ? h('div', { className: 'dr-muted', style: { marginBottom: '6px' } },
                      current.verification.status === 'running'
                        ? '独立验证：进行中…'
                        : `独立验证：${current.verification.verdict === 'confirmed' ? '已确认' : current.verification.verdict === 'rejected' ? '被反证（已折叠）' : '存疑'}${current.verification.reason ? ` — ${current.verification.reason}` : ''}`)
                  : null,
                snapshot.audit
                  ? h('div', { className: 'dr-muted', style: { marginBottom: '6px' } },
                      snapshot.audit.status === 'running'
                        ? '完整性审计：进行中…'
                        : snapshot.audit.status === 'failed'
                          ? `完整性审计失败：${snapshot.audit.error || ''}`
                          : `完整性审计：${snapshot.audit.verdict === 'complete' ? '未发现明显遗漏' : `发现 ${snapshot.audit.gaps.length} 个缺口`}${snapshot.audit.notes ? ` — ${snapshot.audit.notes}` : ''}`)
                  : null,
                ...(current.cards || []).map((cardItem) =>
                  h('div', { key: cardItem.id, style: { borderTop: '1px dashed #23262d', paddingTop: '6px', marginTop: '6px' } },
                    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { className: 'dr-code' }, `${cardItem.file}:${cardItem.startLine}${cardItem.endLine && cardItem.endLine !== cardItem.startLine ? `-${cardItem.endLine}` : ''}`),
                      h('span', { className: 'dr-muted' }, cardItem.decision === 'pending' ? '' : cardItem.decision)),
                    h('div', { style: { whiteSpace: 'pre-wrap', margin: '3px 0' } }, cardItem.problem || cardItem.title),
                    cardItem.suggestion ? h('div', { className: 'dr-muted' }, `建议：${cardItem.suggestion}`) : null,
                    (() => {
                      const buffer = bufferFor(snapshot, cardItem.file);
                      let rows = [];
                      let source = '';
                      if (buffer && buffer.lines.length) {
                        const from = Math.max(1, (cardItem.startLine || 1) - 6);
                        const to = Math.min(buffer.lines.length, (cardItem.startLine || 1) + 6);
                        rows = buffer.lines.slice(from - 1, to).map((text, index) => ({ n: from + index, text }));
                        source = buffer.dirty ? t('vscodeLiveDirty') : t('vscodeLive');
                      } else if (cardItem.excerpt) {
                        rows = cardItem.excerpt.lines;
                        source = t('diskSource');
                      }
                      if (rows.length === 0) return null;
                      return h('div', null,
                        h('div', { className: 'dr-muted', style: { fontSize: '11px' } }, `${t('sourceLabel')}: ${source}`),
                        h('pre', { className: 'dr-gutter', style: { margin: '4px 0', maxHeight: '150px', overflow: 'auto' } },
                          rows.map((line) => {
                            const selected = line.n >= (cardItem.startLine || 1) && line.n <= (cardItem.endLine || cardItem.startLine || 1);
                            return `${selected ? '▶' : ' '} ${String(line.n).padStart(4)}  ${line.text}${selected ? '   // 选中原因：' + (cardItem.title || '问题位置') : ''}`;
                          }).join('\n')));
                    })(),
                    h('div', { className: 'dr-actions', style: { marginTop: '4px' } },
                      h('button', { className: 'dr-btn', type: 'button', onClick: () => { try { const root = String(snapshot.project.root || '').replace(/\\/g, '/').replace(/\/$/, ''); window.open(`vscode://file/${root}/${cardItem.file}:${cardItem.startLine}:1`); } catch (cause) { setMessage({ tone: 'bad', text: String(cause?.message || cause) }); } } }, t('openInVscode')),
                      h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => decide([cardItem.id], 'approved', [cardItem]) }, t('reviewCardsApprove')),
                      h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => decide([cardItem.id], 'needs-revision') }, t('reviewCardsRevision')),
                      h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => decide([cardItem.id], 'ignored') }, t('reviewCardsIgnore')),
                      h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => onAskAgentAt(cardItem.file, cardItem.startLine, { severity: cardItem.severity, title: cardItem.title, problem: cardItem.problem, evidence: cardItem.evidence, impact: cardItem.impact, suggestion: cardItem.suggestion }) }, t('askAgentHere'))))),
                h('div', { className: 'dr-actions', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'dr-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: async () => {
                      setBusy(true); setMessage(null);
                      try {
                        const run = await request(`api/gate/run?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: '{}' });
                        setMessage(run.ok
                          ? { tone: 'ok', text: 'gate 通过' }
                          : { tone: 'bad', text: `gate 失败：${(run.results || []).map((item) => `${item.command} → exit ${item.exitCode}`).join('；') || run.message || ''}` });
                      } catch (cause) {
                        setMessage({ tone: 'bad', text: String(cause?.message || cause) });
                      } finally { setBusy(false); }
                    },
                  }, '运行 gate'),
                  h('button', { className: 'dr-btn', type: 'button', disabled: busy || wtBusy, onClick: createWorktree }, wtBusy ? '…' : '创建审阅 worktree 并注释'),
                  h('button', { className: 'dr-btn', type: 'button', disabled: verifyBusy, onClick: verifyProblem }, verifyBusy ? '验证中…' : '独立 Agent 验证此问题'),
                  h('button', { className: 'dr-btn', type: 'button', disabled: batchReviewBusy, onClick: startBatchReview }, batchReviewBusy ? '评审中…' : '优先文件多视角评审（前 3 个）'),
                  h('button', { className: 'dr-btn', type: 'button', disabled: auditBusy, onClick: runAudit }, auditBusy ? '审计中…' : '完整性审计'),
                  h('button', { className: 'dr-btn primary', type: 'button', disabled: busy, onClick: () => decide((current.cards || []).map((cardItem) => cardItem.id), 'approved', current.cards) }, t('reviewCardsApproveBatch')),
                  h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => decide((current.cards || []).map((cardItem) => cardItem.id), 'ignored') }, t('reviewCardsIgnoreBatch')))),
              worktree
                ? h('div', { className: 'dr-notice', style: { margin: '6px 0 0' } },
                    h('div', { className: 'dr-muted', style: { wordBreak: 'break-all' } }, `审阅工作区：${worktree.path}`),
                    worktree.diffStat ? h('pre', { style: { margin: '4px 0', whiteSpace: 'pre-wrap', fontSize: '11px' } }, worktree.diffStat) : null,
                    h('div', { className: 'dr-actions', style: { marginTop: '4px' } },
                      h('button', { className: 'dr-btn', type: 'button', onClick: () => { try { window.open(`vscode://file/${String(worktree.path).replace(/\\/g, '/')}`); } catch { /* ignore */ } } }, '在 VS Code 打开'),
                      h('button', { className: 'dr-btn', type: 'button', disabled: wtBusy, onClick: removeWorktree }, '清理 worktree')))
                : null,              message ? h('div', { className: `dr-notice ${message.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '6px 0 0' } }, message.text) : null,
            ),
      );
    }

    function FixQueueCard({ snapshot, t, projectId, onRefresh, onAskAgentAt }) {
      const items = snapshot.fixQueue || [];
      const [busy, setBusy] = React.useState('');
      const update = async (id, status) => {
        setBusy(id);
        try {
          await request(`api/fix-queue/update?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ id, status }),
          });
          onRefresh();
        } catch {
          /* next refresh shows the persisted state */
        } finally {
          setBusy('');
        }
      };
      const autoFix = async (item) => {
        setBusy(item.id);
        try {
          await request(`api/fix-queue/auto-fix?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({
              problem: {
                id: item.id, problemId: item.problemId, file: item.file, startLine: item.startLine,
                severity: item.severity, title: item.title, problem: item.problem,
              },
            }),
          });
          onRefresh();
        } catch {
          /* refresh reflects persisted state */
        } finally {
          setBusy('');
        }
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' },
          h('h3', { className: 'dr-card-title' }, t('fixQueue')),
          h('span', { className: 'dr-card-title-sub' }, `${items.filter((item) => item.status !== 'verified').length} 项`)),
        items.length === 0
          ? h('p', { className: 'dr-muted' }, t('fixQueueNone'))
          : items.map((item) =>
              h('div', { key: item.id, className: 'dr-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } },
                h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', width: '100%', flexWrap: 'wrap' } },
                  h('span', { className: `dr-dot ${item.severity === 'blocker' ? 'bad' : item.severity === 'major' ? 'warn' : 'run'}` }),
                  h('span', { className: 'dr-code' }, `${item.file}:${item.startLine}`),
                  h('span', { className: 'dr-muted' }, item.auto ? '自动修复' : ''),
                  h('span', { className: 'dr-muted' }, item.status === 'fixing' ? t('fixQueueStatusStarted') : item.status === 'verified' ? t('fixQueueStatusVerified') : item.status === 'fixed' ? t('fixQueueStatusFixed') : item.status === 'fix-started' ? t('fixQueueStatusStarted') : t('fixQueueStatusQueued')),
                  h('span', { className: 'dr-spacer' }),
                  item.severity === 'minor' ? h('button', { className: 'dr-btn', type: 'button', disabled: busy === item.id || item.status === 'fixing', onClick: () => autoFix(item) }, item.status === 'fixing' ? '修复中…' : '自动修复') : null,
                  h('button', { className: 'dr-btn', type: 'button', disabled: busy === item.id, onClick: () => { onAskAgentAt(item.file, item.startLine, { severity: item.severity, title: item.title, problem: item.problem, evidence: '', impact: '', suggestion: '' }); update(item.id, 'fix-started'); } }, t('fixQueueStart')),
                  h('button', { className: 'dr-btn', type: 'button', disabled: busy === item.id, onClick: () => update(item.id, 'fixed') }, t('fixQueueMarkFixed')),
                  h('button', { className: 'dr-btn', type: 'button', disabled: busy === item.id, onClick: () => update(item.id, 'removed') }, t('fixQueueRemove'))),
                item.title ? h('div', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap' } }, item.title) : null,
                item.report
                  ? h('div', { className: 'dr-muted', style: { fontSize: '11px', whiteSpace: 'pre-wrap' } }, `自动修复结果：${item.report.status}${item.report.gate?.passed ? '（gate 通过）' : '（gate 未通过）'}${item.report.reason ? ` — ${item.report.reason}` : ''}`)
                  : null,
                item.autoError ? h('div', { className: 'dr-muted', style: { color: '#ff9b95', fontSize: '11px' } }, `自动修复失败：${item.autoError}`) : null),
            ),
      );
    }

    function SemanticsView({ semantics }) {
      if (!semantics) return null;
      const definitions = Array.isArray(semantics.definitions) ? semantics.definitions : [];
      return h('div', { className: 'dr-notice', style: { margin: '0 0 6px', maxHeight: '200px', overflow: 'auto' } },
        h('div', { className: 'dr-muted' }, `VS Code LSP 语义（光标 ${semantics.line}:${semantics.character}）`),
        semantics.hover
          ? h('pre', { style: { margin: '2px 0', whiteSpace: 'pre-wrap', fontSize: '12px' } }, semantics.hover)
          : h('div', { className: 'dr-muted' }, '（光标处无悬停信息，在 VS Code 中移动光标即可同步）'),
        definitions.map((definition, index) => h('div', { key: `${definition.file}-${index}`, className: 'dr-row', style: { gap: '6px' } },
          h('span', { className: 'dr-code' }, `${String(definition.file).replace(/\\/g, '/').split('/').slice(-2).join('/')}:${definition.line}`),
          h('button', {
            className: 'dr-btn',
            type: 'button',
            onClick: () => {
              try {
                window.open(`vscode://file/${definition.file}:${definition.line}:1`);
              } catch {
                /* ignore */
              }
            },
          }, '打开定义'))));
    }

    function FileReviewCard({ snapshot, t, projectId, onAskAgentAt, onAnnotateAt, onRefresh }) {
      const allFindings = snapshot.findings || [];
      const [mode, setMode] = React.useState(() => {
        try {
          return localStorage.getItem('ciReview:fileMode') || 'priority';
        } catch {
          return 'priority';
        }
      });
      const [files, setFiles] = React.useState(snapshot.files || []);
      const [selected, setSelected] = React.useState(() => {
        try {
          return localStorage.getItem(`ciReview:file:${projectId}`) || '';
        } catch {
          return '';
        }
      });
      React.useEffect(() => {
        try {
          localStorage.setItem('ciReview:fileMode', mode);
        } catch {
          /* storage may be unavailable */
        }
      }, [mode]);
      React.useEffect(() => {
        try {
          if (selected) localStorage.setItem(`ciReview:file:${projectId}`, selected);
        } catch {
          /* storage may be unavailable */
        }
      }, [projectId, selected]);
      const [file, setFile] = React.useState(null);
      const [line, setLine] = React.useState(0);
      const [error, setError] = React.useState('');
      const [prMessage, setPrMessage] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [editMessage, setEditMessage] = React.useState(null);
      const [reviewJobBusy, setReviewJobBusy] = React.useState(false);
      const selectedJobs = (snapshot.reviewJobs || []).filter((job) => job.file === selected);
      const startReviewJob = async () => {
        if (!selected) return;
        setReviewJobBusy(true);
        setEditMessage(null);
        try {
          const result = await request(`api/review-job/start?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ file: selected, lenses: ['correctness', 'errors', 'security'] }),
          });
          setEditMessage(result.ok
            ? { tone: 'ok', text: `已启动多视角独立评审（${(result.job.lenses || []).join(', ')}），完成后自动出现在审阅卡` }
            : { tone: 'bad', text: result.message || 'review job failed' });
          if (result.ok) onRefresh();
        } catch (cause) {
          setEditMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setReviewJobBusy(false);
        }
      };
      const startEdit = () => {
        if (vsBuffer?.dirty) {
          setEditMessage({ tone: 'bad', text: t('vscodeDirtyBlock') });
          return;
        }
        setDraft(file?.content ?? '');
        setEditing(true);
        setEditMessage(null);
      };
      const saveEdit = async () => {
        setEditMessage({ tone: 'ok', text: '保存中…' });
        try {
          const result = await request(`api/file/save?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ path: selected, content: draft, expectedHash: file?.hash ?? '' }),
          });
          if (!result.ok) {
            setEditMessage({ tone: 'bad', text: result.message || '保存失败' });
            if (result.code === 'stale') {
              const data = await request(`api/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(selected)}`);
              setFile(data.file);
              setDraft(data.file.content ?? '');
            }
            return;
          }
          setEditing(false);
          const data = await request(`api/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(selected)}`);
          setFile(data.file);
          setEditMessage({ tone: 'ok', text: `已保存（备份：${result.backupPath || '无'}），运行 gate…` });
          const gate = await request(`api/gate/run?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: '{}' });
          setEditMessage(gate.ok
            ? { tone: 'ok', text: t('savedOk') }
            : { tone: 'bad', text: `${t('savedFail')}：${(gate.results || []).map((item) => `${item.command} → ${item.exitCode}`).join('；') || gate.message || ''}` });
          onRefresh();
        } catch (cause) {
          setEditMessage({ tone: 'bad', text: String(cause?.message || cause) });
        }
      };
      React.useEffect(() => {
        if (mode === 'priority') setFiles(snapshot.files || []);
      }, [snapshot.files, mode]);
      React.useEffect(() => {
        if (files.length === 0) return;
        if (!files.some((entry) => entry.path === selected)) setSelected(files[0].path);
      }, [files, selected]);
      React.useEffect(() => {
        if (!selected) return undefined;
        let cancelled = false;
        setFile(null);
        request(`api/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(selected)}`)
          .then((data) => { if (!cancelled) setFile(data.file); })
          .catch((cause) => { if (!cancelled) setError(String(cause?.message || cause)); });
        return () => { cancelled = true; };
      }, [selected, projectId]);
      const switchMode = async (nextMode) => {
        setMode(nextMode);
        setError('');
        try {
          const data = await request(`api/files?projectId=${encodeURIComponent(projectId)}&mode=${nextMode}`);
          setFiles(data.files || []);
        } catch (cause) {
          setError(String(cause?.message || cause));
        }
      };
      const fileFindings = allFindings.filter((finding) => finding.file === selected);
      const fileAnnotations = (snapshot.annotations || []).filter((annotation) => annotation.file === selected);
      const marks = new Map();
      for (const finding of fileFindings) {
        const end = Math.min(finding.endLine || finding.startLine, (finding.startLine || 1) + 4);
        for (let number = finding.startLine || 1; number <= end; number += 1) {
          if (!marks.has(number)) marks.set(number, finding.severity);
        }
      }
      const vsBuffer = bufferFor(snapshot, selected);
      const lines = vsBuffer && vsBuffer.lines.length
        ? vsBuffer.lines
        : file && !file.tooLarge && typeof file.content === 'string'
          ? file.content.split('\n')
          : [];
      const diskLines = file && !file.tooLarge && typeof file.content === 'string' ? file.content.split('\n') : [];
      const changedLines = new Set();
      if (vsBuffer && vsBuffer.dirty && diskLines.length) {
        const max = Math.max(lines.length, diskLines.length);
        for (let index = 0; index < max; index += 1) {
          if ((lines[index] ?? null) !== (diskLines[index] ?? null)) changedLines.add(index + 1);
        }
      }
      const diagnosticLines = new Map((vsBuffer?.diagnostics || []).map((item) => [item.line, item.message]));
      const prComments = (snapshot.github?.pr?.reviewComments || []).filter((comment) => comment.path === selected);
      const commentLines = new Map(prComments.map((comment) => [comment.line, comment]));
      const selectedFinding = fileFindings.find((finding) => (finding.startLine || 1) <= line && line <= (finding.endLine || finding.startLine || 1)) ?? null;
      const askHere = () => {
        if (!selected || !line) return;
        onAskAgentAt(selected, line, selectedFinding);
      };
      return h(
        Card,
        null,
        h(
          'div',
          { className: 'dr-card-head' },
          h('h3', { className: 'dr-card-title' }, t('fileReview')),
          h('span', { className: 'dr-card-title-sub' }, t('fileReviewHint')),
          h('span', { className: 'dr-spacer' }),
          editing
            ? null
            : h('button', { className: 'dr-btn', type: 'button', disabled: !selected, onClick: startEdit }, t('editFile')),
          editing
            ? null
            : h('button', { className: 'dr-btn', type: 'button', disabled: reviewJobBusy || !selected, onClick: startReviewJob }, reviewJobBusy ? '评审中…' : '多视角独立评审此文件'),
          h('button', { className: `dr-btn ${mode === 'priority' ? 'primary' : ''}`, type: 'button', onClick: () => switchMode('priority') }, t('filesPriority')),
          h('button', { className: `dr-btn ${mode === 'all' ? 'primary' : ''}`, type: 'button', onClick: () => switchMode('all') }, t('filesAll')),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '230px minmax(0,1fr)', gap: '10px' } },
          h(
            'div',
            { style: { maxHeight: '360px', overflow: 'auto', borderRight: '1px solid #23262d', paddingRight: '6px' } },
            files.length === 0
              ? h('p', { className: 'dr-muted' }, t('filesNone'))
              : files.map((row) =>
                  h(
                    'button',
                    {
                      key: row.path,
                      type: 'button',
                      className: 'dr-project',
                      'data-active': String(row.path === selected),
                      title: row.path,
                      onClick: () => { setSelected(row.path); setLine(0); },
                      style: { textAlign: 'left' },
                    },
                    h(
                      'span',
                      { className: 'dr-project-name', style: { fontSize: '12px', fontWeight: '500' } },
                      row.blockers > 0 ? h('span', { className: 'dr-dot bad' }) : row.majors > 0 ? h('span', { className: 'dr-dot warn' }) : row.findings > 0 ? h('span', { className: 'dr-dot run' }) : h('span', { className: 'dr-dot ok' }),
                      row.path.split('/').slice(-1)[0],
                    ),
                    h(
                      'span',
                      { className: 'dr-project-meta' },
                      row.findings ? `${row.findings} 问题` : '',
                      row.annotations ? ` · ${row.annotations} 批注` : '',
                      row.changed ? ' · PR 改动' : '',
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { style: { minWidth: 0 } },
            error ? h('div', { className: 'dr-notice dr-error' }, error) : null,
            selected
              ? h('div', { className: 'dr-path', style: { marginBottom: '4px' } }, `${selected}${vsBuffer ? ` · ${vsBuffer.dirty ? t('vscodeLiveDirty') : t('vscodeLive')}` : ` · ${t('diskSource')}`}${changedLines.size ? ` · ${interpolate(t('unsavedLines'), { count: changedLines.size })}` : ''}`)
              : h('p', { className: 'dr-muted' }, t('filesPick')),
            line > 0
              ? h(
                  'div',
                  { className: 'dr-notice', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px', borderLeftColor: '#2f81f7' } },
                  h('span', { className: 'dr-code' }, `L${line}`),
                  h('button', { className: 'dr-btn primary', type: 'button', onClick: askHere }, t('askAgentHere')),
                  h('button', { className: 'dr-btn', type: 'button', onClick: () => onAnnotateAt(selected, line) }, t('annotateHere')),
                  h('button', {
                    className: 'dr-btn',
                    type: 'button',
                    onClick: async () => {
                      const text = window.prompt(t('prCommentHere'));
                      if (!text || !text.trim()) return;
                      try {
                        const result = await request(`api/pr/comment?projectId=${encodeURIComponent(projectId)}`, {
                          method: 'POST',
                          body: JSON.stringify({ file: selected, line, body: text.trim() }),
                        });
                        setPrMessage(result.ok ? { tone: 'ok', text: '已发布 PR 行内评论' } : { tone: 'bad', text: result.message || 'failed' });
                        if (result.ok) onRefresh();
                      } catch (cause) {
                        setPrMessage({ tone: 'bad', text: String(cause?.message || cause) });
                      }
                    },
                  }, t('prCommentHere')),
                  h('button', { className: 'dr-btn', type: 'button', onClick: () => { try { navigator.clipboard.writeText(`${selected}:${line}`); } catch { /* ignore */ } } }, t('copyPosition')),
                  selectedFinding ? h('span', { className: 'dr-muted' }, `${selectedFinding.severity} · ${selectedFinding.title}`) : null,
                )
              : null,
            editMessage ? h('div', { className: `dr-notice ${editMessage.tone === 'bad' ? 'dr-error' : ''}`, style: { margin: '0 0 6px' } }, editMessage.text) : null,
            vsBuffer?.semantics ? h(SemanticsView, { semantics: vsBuffer.semantics }) : null,
            selectedJobs.length
              ? h('div', { className: 'dr-muted', style: { marginBottom: '4px', fontSize: '11px' } },
                  selectedJobs.map((job) => {
                    const done = Object.values(job.results || {}).filter((result) => result?.status === 'completed').length;
                    const total = Object.keys(job.results || {}).length;
                    const count = Object.values(job.results || {}).reduce((sum, result) => sum + (Array.isArray(result?.findings) ? result.findings.length : 0), 0);
                    return `多视角评审 ${job.id}: ${job.status}（${done}/${total} 视角完成，${count} 条 finding）`;
                  }).join(' · '))
              : null,
            editing
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  h('textarea', {
                    className: 'dr-input dr-textarea',
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    style: { width: '100%', minHeight: '320px', boxSizing: 'border-box', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px' },
                  }),
                  h('div', { className: 'dr-actions' },
                    h('button', { className: 'dr-btn primary', type: 'button', onClick: saveEdit }, t('saveEdit')),
                    h('button', { className: 'dr-btn', type: 'button', onClick: () => { setEditing(false); setEditMessage(null); } }, t('cancelEdit'))))
              : file && file.tooLarge
              ? h('p', { className: 'dr-muted' }, t('fileTooLarge'))
              : lines.length
                ? h(
                    'div',
                    { style: { maxHeight: '340px', overflow: 'auto', background: '#050608', border: '1px solid #23262d', borderRadius: '8px', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px', lineHeight: '1.55' } },
                    ...lines.slice(0, 4000).map((text, index) => {
                      const number = index + 1;
                      const severity = marks.get(number);
                      const isSelected = number === line;
                      return h(
                        'div',
                        {
                          key: number,
                          onClick: () => setLine(number),
                          style: {
                            display: 'flex',
                            gap: '10px',
                            padding: '0 8px',
                            cursor: 'pointer',
                            background: isSelected ? '#1b2a44' : undefined,
                            borderLeft: severity
                              ? `3px solid ${severity === 'blocker' ? '#f85149' : severity === 'major' ? '#d29922' : '#2f81f7'}`
                              : changedLines.has(number)
                                ? '3px solid #d29922'
                                : '3px solid transparent',
                          },
                        },
                        h('span', { style: { color: '#6f7987', width: '46px', textAlign: 'right', flex: 'none', userSelect: 'none' } }, number),
                        diagnosticLines.has(number)
                          ? h('span', { title: diagnosticLines.get(number), style: { color: '#f0b429', flex: 'none' } }, '⚠')
                          : null,
                        commentLines.has(number)
                          ? h('span', { title: commentLines.get(number).body, style: { color: '#6cb6ff', flex: 'none' } }, '💬')
                          : null,
                        h('span', { style: { whiteSpace: 'pre', color: severity ? '#ffdcd7' : '#e6edf3' } }, text || ' '),
                      );
                    }),
                  )
                : h('p', { className: 'dr-muted' }, t('filesLoading')),
            fileFindings.length
              ? h(
                  'div',
                  { style: { marginTop: '8px' } },
                  h('div', { className: 'dr-muted', style: { marginBottom: '4px' } }, t('fileFindings')),
                  ...fileFindings.map((finding, index) =>
                    h(
                      'div',
                      { key: index, className: 'dr-row', style: { cursor: 'pointer' }, onClick: () => { setSelected(finding.file); setLine(finding.startLine || 1); } },
                      h('span', { className: `dr-dot ${finding.severity === 'blocker' ? 'bad' : finding.severity === 'major' ? 'warn' : 'run'}` }),
                      h('span', { className: 'dr-row-name', title: finding.problem }, `L${finding.startLine} · ${finding.title}`),
                      h('span', { className: 'dr-row-state' }, finding.severity),
                    ),
                  ),
                )
              : null,
            fileAnnotations.length
              ? h('div', { className: 'dr-muted', style: { marginTop: '6px' } }, `${t('annotations')}: ${fileAnnotations.map((a) => `L${a.startLine}`).join(', ')}`)
              : null,
            prMessage ? h('div', { className: `dr-notice ${prMessage.tone === 'bad' ? 'dr-error' : ''}`, style: { marginTop: '6px' } }, prMessage.text) : null,
            prComments.length
              ? h('div', { style: { marginTop: '8px' } },
                  h('div', { className: 'dr-muted', style: { marginBottom: '4px' } }, `${t('prComments')} (${prComments.length})`),
                  ...prComments.map((comment) => h('div', { key: comment.id, className: 'dr-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } },
                    h('div', { className: 'dr-muted', style: { fontSize: '11px' } }, `L${comment.line} · ${comment.user || 'unknown'} · ${comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}`),
                    h('div', { style: { whiteSpace: 'pre-wrap' } }, comment.body))))
              : null,
          ),
        ),
      );
    }

    function AnnotationsCard({ snapshot, t, projectId, onRefresh, onAskAgent, draft, onClearDraft }) {
      const annotations = snapshot.annotations || [];
      const [form, setForm] = React.useState({ file: '', startLine: '', endLine: '', body: '', severity: 'warning' });
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const change = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      React.useEffect(() => {
        if (!draft) return;
        setForm({
          file: draft.file || '',
          startLine: draft.startLine ? String(draft.startLine) : '',
          endLine: '',
          body: draft.body || '',
          severity: 'warning',
        });
      }, [draft]);
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
            if (payload.action === 'create') {
              setForm({ file: '', startLine: '', endLine: '', body: '', severity: 'warning' });
              onClearDraft?.();
            }
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
      const openChild = (childId) => {
        try {
          const sessions = clientServices.sessions;
          const uiWorkspace = clientServices.uiWorkspace;
          const target = sessions?.subagentAddress?.(childId) ?? childId;
          uiWorkspace?.openSession?.(target);
        } catch (cause) {
          setMessage({ tone: 'bad', text: `打开子会话失败：${String(cause?.message || cause)}` });
        }
      };
      const [chat, setChat] = React.useState({ taskId: '', messages: [], error: '', loading: false });
      const [followUp, setFollowUp] = React.useState('');
      const [sending, setSending] = React.useState('');
      const [taskDiff, setTaskDiff] = React.useState({ taskId: '', text: '', error: '', loading: false });
      const toggleDiff = async (taskId) => {
        if (taskDiff.taskId === taskId) {
          setTaskDiff({ taskId: '', text: '', error: '', loading: false });
          return;
        }
        setTaskDiff({ taskId, text: '', error: '', loading: true });
        try {
          const data = await request(`api/agent-task/diff?projectId=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(taskId)}`);
          setTaskDiff({ taskId, text: data.diff || '', error: data.ok ? '' : (data.message || 'failed'), loading: false });
        } catch (cause) {
          setTaskDiff({ taskId, text: '', error: String(cause?.message || cause), loading: false });
        }
      };
      const toggleMessages = async (taskId) => {        if (chat.taskId === taskId) {
          setChat({ taskId: '', messages: [], error: '', loading: false });
          return;
        }
        setChat({ taskId, messages: [], error: '', loading: true });
        try {
          const data = await request(`api/agent-task/messages?projectId=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(taskId)}`);
          if (!data.ok) setChat({ taskId, messages: [], error: data.message || 'failed', loading: false });
          else setChat({ taskId, messages: data.messages || [], error: '', loading: false });
        } catch (cause) {
          setChat({ taskId, messages: [], error: String(cause?.message || cause), loading: false });
        }
      };
      const sendFollowUp = async (taskId) => {
        const text = followUp.trim();
        if (!text) return;
        setSending(taskId);
        setMessage(null);
        try {
          const result = await request(`api/agent-task/message?projectId=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ taskId, message: text }),
          });
          if (result.ok) {
            setMessage({ tone: 'ok', text: t('agentSent') });
            setFollowUp('');
            onRefresh();
          } else {
            setMessage({ tone: 'bad', text: result.message || t('agentStartFailed') });
          }
        } catch (cause) {
          setMessage({ tone: 'bad', text: String(cause?.message || cause) });
        } finally {
          setSending('');
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
          { style: { marginBottom: '10px', border: '1px solid #2a303a', borderRadius: '8px', padding: '10px', background: '#141821' } },
          h('p', { className: 'dr-muted', style: { margin: '0 0 4px', color: '#f5f7fa', fontWeight: '600' } }, draft ? `${t('agentDraftTitle')} · ${t('agentTarget')}: ${draft.target || ''}` : t('agentDraftTitle')),
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
                    task.childId ? h('button', { className: 'dr-btn', type: 'button', title: t('agentSessionHint'), onClick: () => openChild(task.childId) }, t('agentOpenSession')) : null,
                    task.childId ? h('button', { className: 'dr-btn', type: 'button', onClick: () => toggleMessages(task.id) }, chat.taskId === task.id ? t('agentHideMessages') : t('agentShowMessages')) : null,
                    task.report?.changes?.length
                      ? h('button', { className: 'dr-btn', type: 'button', onClick: () => toggleDiff(task.id) }, taskDiff.taskId === task.id ? t('taskDiffHide') : t('taskDiff'))
                      : null,
                    h('span', { className: 'dr-spacer' }),
                    task.status === 'running' ? h('button', { className: 'dr-btn', type: 'button', disabled: busy, onClick: () => cancel(task.id) }, t('agentCancel')) : null,
                  ),
                  h('div', { className: 'dr-muted', style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, task.instruction),
                  chat.taskId === task.id
                    ? h(
                        'div',
                        { style: { background: '#0b0f14', border: '1px solid #23262d', borderRadius: '8px', padding: '8px', margin: '4px 0', maxHeight: '220px', overflow: 'auto' } },
                        chat.loading
                          ? h('p', { className: 'dr-muted' }, '…')
                          : chat.error
                            ? h('p', { className: 'dr-muted', style: { color: '#ff9b95' } }, chat.error)
                            : chat.messages.length === 0
                              ? h('p', { className: 'dr-muted' }, t('agentMessagesEmpty'))
                              : chat.messages.map((row, index) =>
                                  h(
                                    'div',
                                    { key: index, style: { marginBottom: '6px' } },
                                    h('div', { className: 'dr-muted', style: { fontWeight: '600', color: row.role === 'user' ? '#6cb6ff' : '#7ee787' } }, row.role),
                                    h('div', { style: { whiteSpace: 'pre-wrap', color: '#e6edf3', fontSize: '12px' } }, row.text),
                                  ),
                                ),
                      )
                    : null,
                  task.childId
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: '6px', margin: '4px 0 2px', flexWrap: 'wrap' } },
                        h('input', {
                          className: 'dr-input',
                          placeholder: t('agentFollowUpPlaceholder'),
                          value: followUp,
                          onChange: (event) => setFollowUp(event.target.value),
                          style: { flex: 1, minWidth: '220px' },
                        }),
                        h('button', { className: 'dr-btn', type: 'button', disabled: sending === task.id || !followUp.trim(), onClick: () => sendFollowUp(task.id) }, sending === task.id ? '…' : t('agentSend')),
                      )
                    : null,
                  taskDiff.taskId === task.id
                    ? h(
                        'div',
                        { style: { margin: '4px 0', maxHeight: '300px', overflow: 'auto', background: '#050608', border: '1px solid #23262d', borderRadius: '8px', padding: '8px' } },
                        taskDiff.loading
                          ? h('p', { className: 'dr-muted' }, '…')
                          : taskDiff.error
                            ? h('p', { className: 'dr-muted', style: { color: '#ff9b95' } }, taskDiff.error)
                            : h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px', color: '#e6edf3' } }, taskDiff.text || '(no changes)'),
                      )
                    : null,
                  task.error ? h('div', { className: 'dr-notice dr-error', style: { margin: '4px 0' } }, task.error) : null,
                  task.report ? reportLines(task.report, t) : null,
                ),
              ),
            )
          : h('p', { className: 'dr-muted' }, t('agentTasksNone')),
      );
    }

    function ProjectList({ projects, selectedId, onSelect, t, onAddProject }) {
      const [newRoot, setNewRoot] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const add = async () => {
        if (!newRoot.trim()) return;
        setBusy(true);
        setError('');
        try {
          await onAddProject(newRoot.trim());
          setNewRoot('');
        } catch (cause) {
          setError(String(cause?.message || cause));
        } finally {
          setBusy(false);
        }
      };
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
        h(
          'div',
          { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' } },
          h('input', {
            className: 'dr-input',
            placeholder: t('projectPathPlaceholder'),
            value: newRoot,
            onChange: (event) => setNewRoot(event.target.value),
            style: { width: '100%', boxSizing: 'border-box' },
          }),
          h('button', { className: 'dr-btn', type: 'button', disabled: busy || !newRoot.trim(), onClick: add }, busy ? '…' : t('addProject')),
          error ? h('div', { className: 'dr-muted', style: { color: '#ff9b95' } }, error) : null,
        ),
      );
    }

    function Page({ locale }) {
      const [lang, setLang] = React.useState(() => {
        try {
          return localStorage.getItem('ciReview:lang') || 'zh';
        } catch {
          return 'zh';
        }
      });
      React.useEffect(() => {
        try {
          localStorage.setItem('ciReview:lang', lang);
        } catch {
          /* storage may be unavailable */
        }
      }, [lang]);
      const t = React.useCallback((key, params) => {
        const dict = DICT[lang] || DICT.zh;
        const template = dict[key] ?? DICT.zh[key] ?? key;
        return params ? interpolate(template, params) : template;
      }, [lang]);
      const model = useWorkbench(t);
      const snapshot = model.snapshot;
      const [agentDraft, setAgentDraft] = React.useState(null);
      const [annotationDraft, setAnnotationDraft] = React.useState(null);
      const [bridgeCopied, setBridgeCopied] = React.useState(false);
      const [bridgeConnect, setBridgeConnect] = React.useState(false);
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
            snapshot?.vscode?.connected ? h(Badge, { tone: 'ok' }, t('vscodeLive')) : null,
            h('button', { className: 'dr-btn', type: 'button', onClick: () => setLang(lang === 'zh' ? 'en' : 'zh'), title: 'Language / 语言' }, lang === 'zh' ? 'EN' : '中文'),
            h('button', {
              className: 'dr-btn',
              type: 'button',
              onClick: async () => {
                try {
                  let port = window.location.port || '';
                  let token = apiToken();
                  try {
                    const config = await request('api/bridge/config');
                    if (config?.port) port = String(config.port);
                    if (config?.token) token = config.token;
                  } catch {
                    /* fall back to page values */
                  }
                  const payload = JSON.stringify({ port, token });
                  await navigator.clipboard.writeText(payload);
                  setBridgeCopied(true);
                  setTimeout(() => setBridgeCopied(false), 1500);
                } catch {
                  /* clipboard unavailable */
                }
              },
            }, bridgeCopied ? t('bridgeCopied') : t('copyBridge')),
            h('button', {
              className: 'dr-btn',
              type: 'button',
              onClick: async () => {
                try {
                  const result = await request('api/bridge/open-vscode', { method: 'POST', body: '{}' });
                  if (result?.ok) {
                    setBridgeConnect(true);
                    setTimeout(() => setBridgeConnect(false), 2000);
                  } else {
                    setBridgeConnect(false);
                  }
                } catch {
                  /* ignore: VS Code may be absent */
                }
              },
            }, bridgeConnect ? t('connectRequested') : t('connectVscode')),
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
              h(ProjectList, { projects: model.projects, selectedId: model.selectedId, onSelect: model.selectProject, t, onAddProject: model.addProject }),
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
                      h(ReviewCardsCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        onRefresh: model.refresh,
                        onAskAgentAt: (file, line, finding) => setAgentDraft({
                          file, startLine: line, target: `${file}:${line}`,
                          instruction: finding
                            ? `请修复该问题（${finding.severity}）：${finding.title}\n\n位置：${file}:${line}\n问题：${finding.problem}\n证据：${finding.evidence}\n影响：${finding.impact}\n建议：${finding.suggestion}`
                            : `请审阅并修订 ${file}:${line} 附近的代码，保持接口兼容。`,
                          riskBudget: finding && (finding.severity === 'blocker' || finding.severity === 'major') ? 'medium' : 'low',
                        }),
                      }),
                      h(FixQueueCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        onRefresh: model.refresh,
                        onAskAgentAt: (file, line, finding) => setAgentDraft({
                          file, startLine: line, target: `${file}:${line}`,
                          instruction: finding
                            ? `请修复该问题（${finding.severity}）：${finding.title}\n\n位置：${file}:${line}\n问题：${finding.problem}`
                            : `请修复 ${file}:${line} 的问题。`,
                          riskBudget: finding && (finding.severity === 'blocker' || finding.severity === 'major') ? 'medium' : 'low',
                        }),
                      }),
                      h(FileReviewCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        onAskAgentAt: (file, line, finding) => setAgentDraft({
                          file,
                          startLine: line,
                          target: `${file}:${line}`,
                          instruction: finding
                            ? `请修复该问题（${finding.severity}）：${finding.title}\n\n位置：${file}:${line}\n问题：${finding.problem}\n证据：${finding.evidence}\n影响：${finding.impact}\n建议：${finding.suggestion}`
                            : `请审阅并修订 ${file}:${line} 附近的代码，保持接口兼容。`,
                          riskBudget: finding && (finding.severity === 'blocker' || finding.severity === 'major') ? 'medium' : 'low',
                        }),
                        onAnnotateAt: (file, line) => setAnnotationDraft({ file, startLine: line, body: '' }),
                        onRefresh: model.refresh,
                      }),
                      h(PrCard, { snapshot, t, projectId: snapshot.project.id, onRefresh: model.refresh }),
                      h(RunsCard, { snapshot, t, projectId: snapshot.project.id }),
                      h(LocalReviewsCard, { snapshot, t }),
                      h(SessionsCard, { snapshot, t }),
                      h(AnnotationsCard, {
                        snapshot,
                        t,
                        projectId: snapshot.project.id,
                        onRefresh: model.refresh,
                        draft: annotationDraft,
                        onClearDraft: () => setAnnotationDraft(null),
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
        try {
          clientServices.sessions = ctx.get('sessions') ?? null;
          clientServices.uiWorkspace = ctx.get('uiWorkspace') ?? null;
        } catch {
          /* optional services */
        }
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
