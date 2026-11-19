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
    const styles = require('styles');
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
.dr-link{color:var(--dsw-alias-brand-primary,#2563eb);text-decoration:none}
.dr-link:hover{text-decoration:underline}
.dr-actions{display:flex;flex-wrap:wrap;gap:8px}
.dr-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}
.dr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.dr-btn:disabled{opacity:.5;cursor:not-allowed}
.dr-btn.primary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:transparent;color:#fff}
.dr-btn.primary:hover:not(:disabled){opacity:.92;background:var(--dsw-alias-brand-primary,#2563eb)}
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
          pr?.mergeableState ? h(Badge, { tone: pr.mergeableState === 'dirty' ? 'bad' : 'ok' }, pr.mergeableState === 'dirty' ? t('conflicting') : t('mergeable')) : null,
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

    function RunsCard({ snapshot, t }) {
      const github = snapshot.github;
      const runs = github?.pr?.runs ?? [];
      if (!github?.available) return null;
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('runs')), h('span', { className: 'dr-spacer' }),
          h('a', { className: 'dr-link', href: snapshot.capabilities?.actionsUrl || '#', target: '_blank', rel: 'noreferrer' }, t('openActions'))),
        runs.length
          ? runs.map((run) =>
              h(
                'div',
                { className: 'dr-row', key: String(run.id) },
                h('span', { className: `dr-dot ${runTone(run)}` }),
                h('span', { className: 'dr-row-name', title: run.displayTitle || run.name }, run.name || `#${run.id}`),
                h('span', { className: 'dr-row-state' }, run.conclusion || run.status),
                run.htmlUrl ? h('a', { className: 'dr-link', href: run.htmlUrl, target: '_blank', rel: 'noreferrer' }, '↗') : null,
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

    function ActionsCard({ snapshot, t, onRefresh, refreshing }) {
      const links = snapshot.capabilities || {};
      const project = snapshot.project;
      const [copied, setCopied] = React.useState(false);
      const copyBranch = async () => {
        try {
          await navigator.clipboard.writeText(project.branch || '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be unavailable */
        }
      };
      return h(
        Card,
        null,
        h('div', { className: 'dr-card-head' }, h('h3', { className: 'dr-card-title' }, t('next'))),
        h(
          'div',
          { className: 'dr-actions' },
          h('button', { className: 'dr-btn primary', type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? h('span', { className: 'dr-spin' }) : null, refreshing ? t('refreshing') : t('refresh')),
          links.openPrUrl ? h('a', { className: 'dr-btn', href: links.openPrUrl, target: '_blank', rel: 'noreferrer' }, t('openPullRequest')) : null,
          !links.openPrUrl && links.createPrUrl ? h('a', { className: 'dr-btn', href: links.createPrUrl, target: '_blank', rel: 'noreferrer' }, t('createPullRequest')) : null,
          links.actionsUrl ? h('a', { className: 'dr-btn', href: links.actionsUrl, target: '_blank', rel: 'noreferrer' }, t('openActions')) : null,
          links.openRepoUrl ? h('a', { className: 'dr-btn', href: links.openRepoUrl, target: '_blank', rel: 'noreferrer' }, t('openRepo')) : null,
          project.branch ? h('button', { className: 'dr-btn', type: 'button', onClick: copyBranch }, copied ? t('copied') : t('copyBranch')) : null,
        ),
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
      const t = locale || ((key) => key);
      const model = useWorkbench(t);
      const snapshot = model.snapshot;
      return h(
        'div',
        { className: 'dr-root' },
        h(
          'header',
          { className: 'dr-header' },
          h('div', { className: 'dr-headline' }, h('h1', { className: 'dr-title' }, t('title')), h('p', { className: 'dr-subtitle' }, t('subtitle'))),
          h(
            'div',
            { className: 'dr-header-right' },
            h(Badge, { tone: snapshot?.github?.available ? 'ok' : 'warn' }, snapshot?.github?.available ? t('githubReady') : t('githubMissing')),
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
                      h(RunsCard, { snapshot, t }),
                      h(LocalReviewsCard, { snapshot, t }),
                      h(SessionsCard, { snapshot, t }),
                      h(ActionsCard, { snapshot, t, onRefresh: model.refresh, refreshing: model.refreshing }),
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
        ctx.effect(() => styles.insert(CSS), 'ci-review styles');

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
