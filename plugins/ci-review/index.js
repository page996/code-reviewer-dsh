/**
 * Host half of the CI review workbench.
 *
 * Responsibilities:
 *   - discover projects (DSH workspaces + configured extra roots)
 *   - inspect the local Git state
 *   - read GitHub pull request / checks / Actions runs when a credential exists
 *   - read local review runs produced by code-reviewer-dsh (.review/runs)
 *   - list the DSH sessions recorded for a project
 *   - serve the panel through the same-origin HTTP route
 *
 * The panel never talks to GitHub directly: the token stays on the Host and is
 * read from GITHUB_TOKEN/GH_TOKEN or the host's `git credential` helper.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-ci-review';
export const inject = ['webServer'];

const ROUTE = '/dsh-ci-review';
const TOKEN_HEADER = 'x-dsh-ci-review-token';
const GITHUB_API = 'https://api.github.com';
const CREDENTIAL_TTL_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 20000;

function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function projectId(root) {
  return createHash('sha256').update(normalizePath(root)).digest('hex').slice(0, 16);
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  }).trim();
}

function tryGit(root, args) {
  try {
    return runGit(root, args);
  } catch {
    return '';
  }
}

function parseGitHubRemote(remote) {
  const raw = String(remote ?? '').trim();
  if (!raw) return null;
  const trimmed = raw.replace(/\.git$/, '');
  let host;
  let owner;
  let repo;
  let match = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (match) {
    host = match[1];
    owner = match[2];
    repo = match[3];
  } else {
    match = trimmed.match(/^git@([^:]+):([^/]+)\/(.+)$/i);
    if (match) {
      host = match[1];
      owner = match[2];
      repo = match[3];
    } else {
      match = trimmed.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+)$/i);
      if (match) {
        host = match[1];
        owner = match[2];
        repo = match[3];
      }
    }
  }
  if (!host || !owner || !repo) return null;
  if (host.toLowerCase() !== 'github.com') return null;
  return { host: 'github.com', owner, name: repo };
}

function inferGithubRepoFromRoot(root) {
  const remote = tryGit(root, ['remote', 'get-url', 'origin']) || tryGit(root, ['remote', 'get-url', 'upstream']);
  return { remote, repo: parseGitHubRemote(remote) };
}

function checkoutInfo(root) {
  const isGit = tryGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isGit) return { git: false, branch: '', headSha: '', dirty: 0, remote: '', repo: null };
  const branch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = tryGit(root, ['rev-parse', 'HEAD']);
  let dirty = 0;
  try {
    dirty = runGit(root, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).length;
  } catch {
    dirty = 0;
  }
  const { remote, repo } = inferGithubRepoFromRoot(root);
  return {
    git: true,
    branch: branch || '',
    headSha: headSha || '',
    dirty,
    remote: remote || '',
    repo,
  };
}

function readLocalReviewRuns(root, limit = 3) {
  const base = path.join(root, '.review', 'runs');
  let entries;
  try {
    entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(base, entry.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(dir).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { runId: entry.name, dir, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
  return entries.map(({ runId, dir, mtime }) => {
    const meta = safeReadJson(path.join(dir, 'meta.json')) ?? {};
    const gate = safeReadJson(path.join(dir, 'gate.json')) ?? {};
    const aggregate = safeReadJson(path.join(dir, 'aggregate.json')) ?? {};
    const counts = gate.counts ?? aggregate.counts ?? {};
    return {
      runId,
      startedAt: meta.startedAt ?? meta.createdAt ?? new Date(mtime).toISOString(),
      mode: meta.mode ?? '',
      effort: meta.effort ?? '',
      verdict: gate.verdict ?? aggregate.verdict ?? 'unknown',
      exitCode: Number.isInteger(gate.exitCode) ? gate.exitCode : null,
      counts: {
        blocker: Number(counts.blocker) || 0,
        major: Number(counts.major) || 0,
        minor: Number(counts.minor) || 0,
        needsHuman: Number(counts.needsHuman) || 0,
      },
      reportPath: path.join('.review', 'runs', runId, 'report.md'),
    };
  });
}

export function apply(ctx, config = {}) {
  const refreshSeconds = Number.isFinite(Number(config.refreshSeconds)) && Number(config.refreshSeconds) > 0
    ? Number(config.refreshSeconds)
    : 20;
  const refreshMs = refreshSeconds * 1000;
  const token = randomBytes(24).toString('base64url');
  const snapshotCache = new Map();
  let credential = { value: '', source: 'none', at: 0 };

  function log(message) {
    try {
      const logger = ctx.get('logger');
      logger?.debug?.(`[ci-review] ${message}`);
    } catch {
      /* logging is best effort */
    }
  }

  /* ------------------------------------------------------------ credentials */

  function envToken() {
    const direct = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    return direct ? { value: direct, source: 'env' } : null;
  }

  function gitCredentialToken() {
    try {
      const output = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      });
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('password=')) {
          const value = line.slice('password='.length).trim();
          return value ? { value, source: 'git-credential' } : null;
        }
      }
    } catch {
      /* no usable credential helper */
    }
    return null;
  }

  function currentCredential(force = false) {
    const now = Date.now();
    if (!force && credential.value && now - credential.at < CREDENTIAL_TTL_MS) return credential;
    const resolved = envToken() ?? gitCredentialToken();
    if (resolved) credential = { ...resolved, at: now };
    else credential = { value: '', source: 'none', at: now };
    return credential;
  }

  /* --------------------------------------------------------------- projects */

  function configuredProjects() {
    const list = Array.isArray(config.projects) ? config.projects : [];
    const result = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const root = typeof entry.root === 'string' ? entry.root.trim() : '';
      if (!root) continue;
      const resolved = path.resolve(root);
      result.push({
        id: projectId(resolved),
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.basename(resolved),
        root: resolved,
        source: 'config',
      });
    }
    return result;
  }

  function registryProjects() {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return [];
    const result = [];
    try {
      for (const workspace of registry.list()) {
        if (!workspace || typeof workspace.path !== 'string') continue;
        result.push({
          id: projectId(workspace.path),
          name: workspace.title || path.basename(workspace.path),
          root: workspace.path,
          source: 'workspace',
        });
        // A DSH workspace is often a container (E:\work) rather than the Git
        // checkout itself; surface immediate child repositories too so the
        // panel is useful without extra configuration.
        let entries = [];
        try {
          entries = fs.readdirSync(workspace.path, { withFileTypes: true });
        } catch {
          entries = [];
        }
        let added = 0;
        for (const entry of entries) {
          if (added >= 20) break;
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const child = path.join(workspace.path, entry.name);
          let isGit = false;
          try {
            isGit = fs.existsSync(path.join(child, '.git')) || fs.statSync(path.join(child, '.git')).isFile();
          } catch {
            isGit = false;
          }
          if (!isGit) continue;
          result.push({
            id: projectId(child),
            name: entry.name,
            root: child,
            source: 'workspace-nested',
          });
          added += 1;
        }
      }
    } catch (error) {
      log(`workspace registry unavailable: ${error?.message ?? error}`);
    }
    return result;
  }

  function discoverProjects() {
    const byId = new Map();
    for (const project of registryProjects()) byId.set(project.id, project);
    for (const project of configuredProjects()) byId.set(project.id, project);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function findProject(id) {
    if (!id) return null;
    return discoverProjects().find((project) => project.id === id) ?? null;
  }

  function projectSummary(project) {
    const checkout = checkoutInfo(project.root);
    let exists = true;
    try {
      exists = fs.statSync(project.root).isDirectory();
    } catch {
      exists = false;
    }
    return {
      id: project.id,
      name: project.name,
      root: project.root,
      source: project.source,
      exists,
      git: checkout.git,
      branch: checkout.branch,
      headSha: checkout.headSha.slice(0, 12),
      dirty: checkout.dirty,
      remote: checkout.remote,
      repo: checkout.repo ? `${checkout.repo.owner}/${checkout.repo.name}` : null,
    };
  }

  /* ---------------------------------------------------------------- github */

  async function githubRequest(apiPath) {
    const active = currentCredential();
    if (!active.value) throw new Error('missing-token');
    const response = await fetch(`${GITHUB_API}${apiPath}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-ci-review',
        Authorization: `Bearer ${active.value}`,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub ${response.status} ${response.statusText} ${text.slice(0, 160)}`.trim());
    }
    return response.json();
  }

  function normalizeCheckRun(check) {
    return {
      kind: 'check-run',
      name: check.name ?? '',
      workflow: check.check_suite?.app?.name ?? check.app?.name ?? '',
      status: check.status ?? 'unknown',
      conclusion: check.conclusion ?? null,
      startedAt: check.started_at ?? null,
      completedAt: check.completed_at ?? null,
      url: check.html_url ?? null,
    };
  }

  function normalizeStatus(status) {
    return {
      kind: 'status',
      name: status.context ?? '',
      workflow: status.creator?.login ?? '',
      status: 'completed',
      conclusion: status.state === 'success' ? 'success'
        : status.state === 'failure' ? 'failure'
          : status.state === 'pending' ? 'pending'
            : 'neutral',
      startedAt: status.created_at ?? null,
      completedAt: status.updated_at ?? null,
      url: status.target_url ?? null,
    };
  }

  function rollupChecks(items) {
    const counts = { passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 };
    for (const item of items) {
      if (item.status && item.status !== 'completed') {
        counts.running += 1;
      } else if (item.conclusion === 'success') {
        counts.passed += 1;
      } else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(item.conclusion)) {
        counts.failed += 1;
      } else if (['skipped', 'neutral', 'stale'].includes(item.conclusion)) {
        counts.skipped += 1;
      } else {
        counts.neutral += 1;
      }
    }
    const rollup = counts.failed > 0 ? 'failure'
      : counts.running > 0 ? 'pending'
        : items.length === 0 ? 'none'
          : 'success';
    return { rollup, counts };
  }

  async function readChecks(repo, sha) {
    const [checkRuns, statuses] = await Promise.all([
      githubRequest(`/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
      githubRequest(`/repos/${repo.owner}/${repo.name}/commits/${sha}/status`).catch(() => ({ statuses: [] })),
    ]);
    const items = [
      ...(Array.isArray(checkRuns.check_runs) ? checkRuns.check_runs.map(normalizeCheckRun) : []),
      ...(Array.isArray(statuses.statuses) ? statuses.statuses.map(normalizeStatus) : []),
    ].sort((a, b) => {
      const rank = (item) => (item.conclusion && item.status === 'completed' && !['success', 'skipped', 'neutral'].includes(item.conclusion) ? 0 : item.status !== 'completed' ? 1 : 2);
      const delta = rank(a) - rank(b);
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    });
    return { ...rollupChecks(items), items };
  }

  async function readRuns(repo, branch) {
    if (!branch) return [];
    const data = await githubRequest(
      `/repos/${repo.owner}/${repo.name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=8`,
    ).catch(() => ({ workflow_runs: [] }));
    return (Array.isArray(data.workflow_runs) ? data.workflow_runs : []).map((run) => ({
      id: run.id,
      name: run.name ?? run.workflow_name ?? '',
      displayTitle: run.display_title ?? '',
      event: run.event ?? '',
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at ?? null,
      runStartedAt: run.run_started_at ?? null,
      updatedAt: run.updated_at ?? null,
      htmlUrl: run.html_url ?? null,
      headBranch: run.head_branch ?? '',
    }));
  }

  function reviewDecisionFromReviews(reviews) {
    const latest = new Map();
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const login = review.user?.login;
      if (!login || review.state === 'PENDING') continue;
      latest.set(login, review.state);
      if (review.submitted_at) latest.set(`${login}:at`, review.submitted_at);
    }
    const states = [...latest.entries()].filter(([key]) => !key.includes(':')).map(([, value]) => value);
    const decision = states.includes('CHANGES_REQUESTED') ? 'changes_requested'
      : states.includes('APPROVED') ? 'approved'
        : 'none';
    const latestRows = [...latest.entries()]
      .filter(([key]) => !key.includes(':'))
      .map(([login, state]) => ({ login, state, at: latest.get(`${login}:at`) ?? null }));
    return { decision, latest: latestRows };
  }

  async function buildGithubSnapshot(projectSummaryData) {
    const repo = projectSummaryData.repo ? { owner: projectSummaryData.repo.split('/')[0], name: projectSummaryData.repo.split('/')[1] } : null;
    if (!projectSummaryData.git) return { available: false, status: 'not-git', repo: null };
    if (!repo) return { available: false, status: 'missing-remote', repo: null };
    const active = currentCredential();
    if (!active.value) {
      return { available: false, status: 'missing-token', repo: `${repo.owner}/${repo.name}`, source: 'none' };
    }
    try {
      const base = `/repos/${repo.owner}/${repo.name}`;
      const openPrs = await githubRequest(`${base}/pulls?state=open&per_page=20&sort=updated&direction=desc`);
      const branch = projectSummaryData.branch;
      const prs = Array.isArray(openPrs) ? openPrs : [];
      const pr = prs.find((item) => item.head?.ref === branch) ?? null;
      let checks = { rollup: 'none', counts: { passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 }, items: [] };
      let runs = [];
      let reviews = { decision: 'none', latest: [] };
      let detail = null;
      if (pr) {
        detail = await githubRequest(`${base}/pulls/${pr.number}`).catch(() => pr);
        const headSha = detail?.head?.sha ?? pr.head?.sha;
        [checks, runs, reviews] = await Promise.all([
          headSha ? readChecks(repo, headSha) : checks,
          readRuns(repo, branch),
          githubRequest(`${base}/pulls/${pr.number}/reviews?per_page=100`).then(reviewDecisionFromReviews).catch(() => reviews),
        ]);
      }
      return {
        available: true,
        status: 'ok',
        repo: `${repo.owner}/${repo.name}`,
        source: active.source,
        branch,
        pr: pr
          ? {
              number: pr.number,
              title: pr.title ?? '',
              state: detail?.state ?? pr.state ?? 'open',
              draft: Boolean(detail?.draft ?? pr.draft),
              merged: Boolean(detail?.merged ?? pr.merged),
              htmlUrl: detail?.html_url ?? pr.html_url ?? null,
              headRef: detail?.head?.ref ?? pr.head?.ref ?? branch,
              headSha: (detail?.head?.sha ?? pr.head?.sha ?? '').slice(0, 12),
              baseRef: detail?.base?.ref ?? pr.base?.ref ?? '',
              mergeable: detail?.mergeable ?? null,
              mergeableState: detail?.mergeable_state ?? null,
              author: detail?.user?.login ?? pr.user?.login ?? '',
              createdAt: pr.created_at ?? null,
              updatedAt: detail?.updated_at ?? pr.updated_at ?? null,
              changedFiles: detail?.changed_files ?? null,
              additions: detail?.additions ?? null,
              deletions: detail?.deletions ?? null,
              checks,
              reviews,
              runs,
            }
          : null,
        openPullRequests: prs.map((item) => ({
          number: item.number,
          title: item.title ?? '',
          headRef: item.head?.ref ?? '',
          htmlUrl: item.html_url ?? null,
          draft: Boolean(item.draft),
        })),
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      return {
        available: false,
        status: 'request-failed',
        repo: `${repo.owner}/${repo.name}`,
        reason: message.slice(0, 240),
      };
    }
  }

  async function readSessions(root) {
    const query = ctx.get('sessionQuery');
    if (!query || typeof query.listSessions !== 'function') return [];
    let rows;
    try {
      rows = await query.listSessions();
    } catch (error) {
      log(`sessionQuery unavailable: ${error?.message ?? error}`);
      return [];
    }
    const prefix = normalizePath(root);
    const result = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      const cwd = String(row.cwd ?? row.header?.cwd ?? '');
      if (!cwd || !normalizePath(cwd).startsWith(prefix)) continue;
      const id = String(row.id ?? row.sessionId ?? row.header?.id ?? '');
      if (!id) continue;
      result.push({
        id,
        title: String(row.title ?? row.header?.title ?? ''),
        cwd,
        updatedAt: row.updatedAt ?? row.header?.updatedAt ?? row.time ?? null,
        archived: row.archived === true,
        activity: row.activity ?? row.status ?? null,
      });
    }
    return result
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, 8);
  }

  /* -------------------------------------------------------------- snapshot */

  async function buildSnapshot(project) {
    const summary = projectSummary(project);
    const [github, sessions] = await Promise.all([
      buildGithubSnapshot(summary),
      readSessions(project.root),
    ]);
    const localReviews = summary.exists ? readLocalReviewRuns(project.root) : [];
    const repoUrl = summary.repo ? `https://github.com/${summary.repo}` : null;
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      project: summary,
      github,
      localReviews,
      sessions,
      capabilities: {
        openRepoUrl: repoUrl,
        openPrUrl: github.available && github.pr?.htmlUrl ? github.pr.htmlUrl : null,
        createPrUrl: summary.repo && summary.branch
          ? `https://github.com/${summary.repo}/compare/${encodeURIComponent(summary.branch)}?expand=1`
          : null,
        actionsUrl: summary.repo ? `${repoUrl}/actions` : null,
        canReadGithub: github.available,
      },
      links: { base: ROUTE },
    };
  }

  async function snapshotFor(project, { force = false } = {}) {
    const cached = snapshotCache.get(project.id);
    if (!force && cached && Date.now() - cached.at < refreshMs) return cached.snapshot;
    const snapshot = await buildSnapshot(project);
    snapshotCache.set(project.id, { at: Date.now(), snapshot });
    return snapshot;
  }

  /* ------------------------------------------------------------------- http */

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendError(res, status, message) {
    sendJson(res, status, { ok: false, error: message });
  }

  function checkToken(req) {
    const header = String(req.headers[TOKEN_HEADER] ?? '');
    return header.length > 0 && header === token;
  }

  function checkOrigin(req) {
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (fetchSite === 'cross-site') return false;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin) {
      try {
        const parsed = new URL(origin);
        return parsed.host === String(req.headers.host ?? '');
      } catch {
        return false;
      }
    }
    return true;
  }

  function isAuthenticated(req) {
    try {
      const connection = ctx.get('connection');
      const admission = connection?.admit?.(req);
      if (admission && typeof admission === 'object' && 'peer' in admission) return true;
    } catch {
      /* fall through */
    }
    if (checkToken(req)) return true;
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (!['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
    const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  }

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/health`) {
      return sendJson(res, 200, { ok: true, plugin: name, refreshSeconds, tokenConfigured: Boolean(token) });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/projects`) {
      const active = currentCredential();
      const projects = discoverProjects().map((project) => {
        const summary = projectSummary(project);
        return {
          id: summary.id,
          name: summary.name,
          root: summary.root,
          source: summary.source,
          exists: summary.exists,
          git: summary.git,
          branch: summary.branch,
          headSha: summary.headSha,
          dirty: summary.dirty,
          repo: summary.repo,
          githubToken: active.value ? active.source : 'none',
        };
      });
      return sendJson(res, 200, { ok: true, projects, refreshSeconds });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/snapshot`) {
      const projectIdParam = url.searchParams.get('projectId') ?? '';
      const project = findProject(projectIdParam);
      if (!project) return sendError(res, 404, 'unknown project');
      const snapshot = await snapshotFor(project, { force: url.searchParams.get('force') === '1' });
      return sendJson(res, 200, snapshot);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/refresh`) {
      const projectIdParam = url.searchParams.get('projectId') ?? '';
      const project = findProject(projectIdParam);
      if (!project) return sendError(res, 404, 'unknown project');
      const snapshot = await snapshotFor(project, { force: true });
      return sendJson(res, 200, snapshot);
    }
    return sendError(res, 404, 'unknown ci-review API route');
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      if (!url.pathname.startsWith(ROUTE)) return sendError(res, 404, 'not found');
      if (url.pathname.startsWith(`${ROUTE}/api/`)) {
        if (!checkOrigin(req)) return sendError(res, 403, 'cross-site request refused');
        if (!isAuthenticated(req)) return sendError(res, 401, 'missing or invalid ci-review authentication');
        return await handleApi(req, res, url);
      }
      return sendError(res, 404, 'not found');
    } catch (error) {
      log(`HTTP error: ${error?.stack ?? error}`);
      if (!res.headersSent) sendError(res, 500, error?.message ?? String(error));
      else res.end();
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handleRequest }),
    'ci-review routes',
  );

  ctx.effect(
    () => ctx.webServer.tapIndex((html) => {
      const marker = 'window.__DSH_CI_REVIEW_TOKEN__';
      if (html.includes(marker)) return html;
      const script = `<script>${marker}=${JSON.stringify(token)};window.__DSH_CI_REVIEW_BASE__=${JSON.stringify(`${ROUTE}/`)};</script>`;
      return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`;
    }),
    'ci-review page token',
  );

  log(`mounted at ${ROUTE} (workspaces: ${registryProjects().length}, configured: ${configuredProjects().length})`);
}
