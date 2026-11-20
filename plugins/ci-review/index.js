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
import os from 'node:os';
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
  const snapshotInflight = new Map();
  const snapshotDiskDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ci-review-cache');

  function hostPort(req) {
    const host = String(req?.headers?.host ?? '');
    const part = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '';
    return Number(part) || null;
  }

  function writeBridgeDiscovery(portOverride = null) {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      let port = Number(portOverride) || null;
      if (!port) {
        try {
          port = Number(new URL(process.env.DSH_WEB_URL || '').port) || null;
        } catch {
          port = null;
        }
      }
      const file = path.join(home, 'ci-review-bridge.json');
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ port, token, route: ROUTE, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      return file;
    } catch {
      return null;
    }
  }

  function diskSnapshotPath(projectId) {
    return path.join(snapshotDiskDir, `${projectId}.json`);
  }

  function readDiskSnapshot(projectId) {
    try {
      return JSON.parse(fs.readFileSync(diskSnapshotPath(projectId), 'utf8'));
    } catch {
      return null;
    }
  }

  function writeDiskSnapshot(projectId, snapshot) {
    try {
      fs.mkdirSync(snapshotDiskDir, { recursive: true });
      fs.writeFileSync(diskSnapshotPath(projectId), JSON.stringify(snapshot), 'utf8');
    } catch {
      /* cache is best effort */
    }
  }

  function storeSnapshot(project, snapshot) {
    snapshotCache.set(project.id, { at: Date.now(), snapshot });
    if (snapshot && !snapshot.stale) writeDiskSnapshot(project.id, snapshot);
  }

  function scheduleSnapshotRebuild(project) {
    if (snapshotInflight.has(project.id)) return;
    const promise = buildSnapshot(project)
      .then((snapshot) => {
        storeSnapshot(project, snapshot);
      })
      .catch(() => {})
      .finally(() => {
        snapshotInflight.delete(project.id);
      });
    snapshotInflight.set(project.id, promise);
  }
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

  function extraProjectsPath() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'ci-review-projects.json');
  }

  function readExtraProjects() {
    const data = readJsonFile(extraProjectsPath());
    if (!Array.isArray(data?.projects)) return [];
    return data.projects
      .filter((entry) => entry && typeof entry.root === 'string')
      .map((entry) => ({ root: path.resolve(entry.root), name: typeof entry.name === 'string' ? entry.name : '' }));
  }

  function writeExtraProjects(projects) {
    const file = extraProjectsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  function readJsonFile(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function discoverProjects() {
    const byId = new Map();
    for (const project of registryProjects()) byId.set(project.id, project);
    for (const project of configuredProjects()) byId.set(project.id, project);
    for (const entry of readExtraProjects()) {
      let stat = null;
      try {
        stat = fs.statSync(entry.root);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) continue;
      const id = projectId(entry.root);
      byId.set(id, { id, name: entry.name || path.basename(entry.root), root: entry.root, source: 'imported' });
    }
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

  async function githubRequest(apiPath, options = {}) {
    const active = currentCredential();
    if (!active.value) throw new Error('missing-token');
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-ci-review',
      Authorization: `Bearer ${active.value}`,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${GITHUB_API}${apiPath}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub ${response.status} ${response.statusText} ${text.slice(0, 160)}`.trim());
    }
    if (response.status === 204) return null;
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

  async function readPrFiles(repo, number) {
    const data = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100`).catch(() => []);
    return (Array.isArray(data) ? data : [])
      .map((file) => file?.filename)
      .filter((file) => typeof file === 'string');
  }

  async function readPrComments(repo, number) {
    const data = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls/${number}/comments?per_page=100`).catch(() => []);
    return (Array.isArray(data) ? data : []).map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: Number(comment.line ?? comment.original_line) || 1,
      side: comment.side ?? 'RIGHT',
      body: String(comment.body ?? '').slice(0, 4000),
      user: comment.user?.login ?? '',
      createdAt: comment.created_at ?? null,
      url: comment.html_url ?? null,
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

  /* ----------------------------------------------------------- forge data */

  const forge = (() => {
    try {
      return ctx.get('forge') ?? null;
    } catch {
      return null;
    }
  })();
  const forgeWatches = new Map();

  function forgeRepositoryFor(remote) {
    if (!forge || typeof forge.repositoryFromRemote !== 'function' || !remote) return null;
    try {
      return forge.repositoryFromRemote(remote) ?? null;
    } catch {
      return null;
    }
  }

  async function forgeReadiness(repository) {
    if (!forge || typeof forge.readiness !== 'function') return { state: 'unavailable', message: 'forge service not mounted' };
    try {
      return await forge.readiness(repository, AbortSignal.timeout(HTTP_TIMEOUT_MS));
    } catch (error) {
      return { state: 'unavailable', message: String(error?.message ?? error) };
    }
  }

  function forgeWatchKey(ref) {
    return `${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}#${ref.number}`;
  }

  /** Keep one shared poll per change request and resolve with its latest snapshot. */
  function forgeUpdateFor(ref, timeoutMs = 25000) {
    if (!forge || typeof forge.watch !== 'function') return Promise.reject(new Error('forge-unavailable'));
    const key = forgeWatchKey(ref);
    let entry = forgeWatches.get(key);
    if (!entry) {
      entry = { ref, snapshot: null, failure: null, accessedAt: Date.now(), dispose: null };
      entry.dispose = forge.watch(ref, (update) => {
        entry.accessedAt = Date.now();
        if (update && update.snapshot) {
          entry.snapshot = update.snapshot;
          entry.failure = null;
        } else if (update && update.failure) {
          entry.failure = update.failure;
        }
      });
      forgeWatches.set(key, entry);
    }
    entry.accessedAt = Date.now();
    if (entry.snapshot) return Promise.resolve(entry);
    if (entry.failure) return Promise.reject(new Error(entry.failure.message || entry.failure.code));
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (entry.snapshot) {
          clearInterval(timer);
          resolve(entry);
          return;
        }
        if (entry.failure) {
          clearInterval(timer);
          reject(new Error(entry.failure.message || entry.failure.code));
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('forge-poll-timeout'));
        }
      }, 300);
    });
  }

  function forgeChecks(snapshot) {
    const items = (Array.isArray(snapshot.checks) ? snapshot.checks : []).map((check) => ({
      kind: 'forge-check',
      name: check.name ?? '',
      workflow: check.workflow ?? '',
      status: check.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: check.state === 'pending' ? null : check.state,
      startedAt: check.startedAt ?? null,
      completedAt: check.completedAt ?? null,
      url: check.url ?? null,
      rerun: Boolean(check.rerun),
    }));
    const counts = { passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 };
    for (const item of items) {
      if (item.status !== 'completed') counts.running += 1;
      else if (item.conclusion === 'success') counts.passed += 1;
      else if (item.conclusion === 'failure' || item.conclusion === 'cancelled') counts.failed += 1;
      else if (['skipped', 'neutral'].includes(item.conclusion)) counts.skipped += 1;
      else counts.neutral += 1;
    }
    return {
      items,
      counts,
      rollup: snapshot.checksRollup ?? 'none',
      truncated: Boolean(snapshot.checksTruncated),
    };
  }

  function forgeActions(snapshot, checks) {
    const failed = checks.counts.failed;
    const mergeMethods = Array.isArray(snapshot.mergeMethods) ? snapshot.mergeMethods : [];
    const branchUpdates = Array.isArray(snapshot.branchUpdates) ? snapshot.branchUpdates : [];
    return {
      dataSource: 'forge',
      rerun: {
        enabled: Boolean(snapshot.canRerunChecks) && failed > 0,
        reason: !snapshot.canRerunChecks ? '当前仓库或权限不允许重跑检查'
          : failed === 0 ? '没有失败的检查' : null,
      },
      markReady: {
        enabled: Boolean(snapshot.draft),
        reason: snapshot.draft ? null : 'PR 不是草稿',
      },
      updateBranch: {
        enabled: branchUpdates.length > 0,
        methods: branchUpdates,
        reason: branchUpdates.length === 0 ? 'provider 不支持更新分支' : null,
      },
      merge: {
        enabled: Boolean(snapshot.mergeReady) && snapshot.mergeability === 'mergeable' && mergeMethods.length > 0,
        methods: mergeMethods,
        reason: !snapshot.mergeReady ? 'PR 还不满足合并条件'
          : snapshot.mergeability !== 'mergeable' ? '存在冲突或可合并性未知'
            : mergeMethods.length === 0 ? '仓库未开放合并方式' : null,
      },
    };
  }

  function normalizeForgePr(snapshot) {
    const checks = forgeChecks(snapshot);
    const reviewers = Array.isArray(snapshot.reviewers) ? snapshot.reviewers : [];
    return {
      number: snapshot.ref.number,
      title: snapshot.title ?? '',
      state: snapshot.state ?? 'open',
      draft: Boolean(snapshot.draft),
      merged: snapshot.state === 'merged',
      htmlUrl: snapshot.url ?? null,
      headRef: snapshot.headBranch ?? '',
      headSha: snapshot.headSha ?? '',
      baseRef: snapshot.baseBranch ?? '',
      mergeable: snapshot.mergeability === 'mergeable' ? true : snapshot.mergeability === 'conflicting' ? false : null,
      mergeableState: snapshot.mergeability ?? null,
      mergeReady: Boolean(snapshot.mergeReady),
      mergeMethods: Array.isArray(snapshot.mergeMethods) ? snapshot.mergeMethods : [],
      branchUpdates: Array.isArray(snapshot.branchUpdates) ? snapshot.branchUpdates : [],
      reviewDecision: snapshot.reviewDecision ?? 'none',
      reviewers: reviewers.map((reviewer) => ({
        kind: reviewer.kind,
        login: reviewer.login,
        requested: Boolean(reviewer.requested),
        verdict: reviewer.verdict ?? null,
      })),
      unresolvedThreads: Number(snapshot.unresolvedThreads) || 0,
      author: snapshot.author ?? '',
      createdAt: null,
      updatedAt: snapshot.updatedAt ?? null,
      changedFiles: null,
      additions: snapshot.additions ?? null,
      deletions: snapshot.deletions ?? null,
      checks,
      reviews: {
        decision: snapshot.reviewDecision ?? 'none',
        latest: reviewers
          .filter((reviewer) => reviewer.verdict)
          .map((reviewer) => ({ login: reviewer.login, state: reviewer.verdict, at: null })),
      },
      runs: [],
      forge: {
        mergeability: snapshot.mergeability ?? 'unknown',
        checksTruncated: Boolean(snapshot.checksTruncated),
        threadsTruncated: Boolean(snapshot.threadsTruncated),
      },
    };
  }

  /* --------------------------------------------------------------- gh CLI */

  // Windows/Node 24 workaround: the installed forge-github provider passes a
  // multi-line GraphQL query as a single spawn argument, which Node rejects on
  // Windows ("cannot contain a line break ... without a shell"). The panel
  // therefore performs write actions through the authenticated `gh` CLI, whose
  // arguments are single-line. Reads keep using the REST fallback.
  let ghExecutable;
  function resolveGh() {
    if (ghExecutable !== undefined) return ghExecutable;
    const candidates = [
      typeof config.ghCommand === 'string' && config.ghCommand ? config.ghCommand : '',
      'gh',
      'C:/Program Files/GitHub CLI/gh.exe',
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        ghExecutable = candidate;
        return ghExecutable;
      } catch {
        /* try the next candidate */
      }
    }
    ghExecutable = null;
    return ghExecutable;
  }

  function ghReady() {
    return Boolean(resolveGh());
  }

  function runGh(args, timeoutMs = 30000) {
    const executable = resolveGh();
    if (!executable) throw new Error('gh-not-found');
    return execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1' },
    }).trim();
  }

  function restActions(pr, runs) {
    const ghOk = ghReady();
    const failed = pr?.checks?.counts?.failed ?? 0;
    const failedRun = (Array.isArray(runs) ? runs : []).find((run) =>
      run.conclusion && ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion));
    const mergeState = pr?.mergeableState;
    const checksRollup = pr?.checks?.rollup;
    const noGh = '未找到或未登录 gh CLI';
    return {
      dataSource: 'gh-cli',
      ghAvailable: ghOk,
      rerun: {
        enabled: ghOk && failed > 0 && Boolean(failedRun),
        runId: failedRun?.id ?? null,
        reason: !ghOk ? noGh : failed === 0 ? '没有失败的检查' : !failedRun ? '没有找到失败的 Actions 运行' : null,
      },
      markReady: {
        enabled: ghOk && Boolean(pr?.draft),
        reason: !ghOk ? noGh : !pr ? '当前分支没有打开的 PR' : !pr.draft ? 'PR 不是草稿' : null,
      },
      updateBranch: {
        enabled: ghOk && Boolean(pr),
        methods: ['merge'],
        hint: '分支未落后时 GitHub 会拒绝该操作',
        reason: !ghOk ? noGh : !pr ? '当前分支没有打开的 PR' : null,
      },
      merge: {
        enabled: ghOk && Boolean(pr) && mergeState === 'clean' && checksRollup === 'success' && !pr?.draft,
        methods: ['squash', 'merge', 'rebase'],
        reason: !ghOk ? noGh
          : !pr ? '当前分支没有打开的 PR'
            : mergeState !== 'clean' ? (mergeState === 'dirty' ? '与基线冲突' : '分支未更新或合并状态未知')
              : checksRollup !== 'success' ? '检查未全部通过'
                : null,
      },
    };
  }

  async function runGhAction({ action, method, project, summary, pr, runs }) {
    if (!ghReady()) return { ok: false, code: 'unsupported', message: '未找到或未登录 gh CLI' };
    const full = summary.repo;
    if (!full) return { ok: false, code: 'unsupported', message: '项目没有 GitHub 仓库' };
    try {
      if (action === 'rerun') {
        const failedRun = (Array.isArray(runs) ? runs : []).find((run) =>
          run.conclusion && ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion));
        if (!failedRun) return { ok: false, code: 'failed', message: '没有失败的 Actions 运行可重跑' };
        runGh(['run', 'rerun', String(failedRun.id), '--failed', '-R', full], 60000);
        return { ok: true, action, message: `已请求重跑运行 #${failedRun.id} 的失败任务` };
      }
      if (action === 'mark-ready') {
        runGh(['pr', 'ready', String(pr.number), '-R', full], 60000);
        return { ok: true, action, message: '已把 PR 标记为可审阅' };
      }
      if (action === 'update-branch') {
        const updateMethod = method === 'rebase' ? 'rebase' : 'merge';
        runGh(
          ['api', '-X', 'PUT', `repos/${full}/pulls/${pr.number}/update-branch`, '-f', `update_method=${updateMethod}`],
          60000,
        );
        return { ok: true, action, message: `已请求用 ${updateMethod} 更新 PR 分支` };
      }
      if (action === 'merge') {
        const mergeMethod = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';
        const flag = mergeMethod === 'merge' ? '--merge' : mergeMethod === 'rebase' ? '--rebase' : '--squash';
        runGh(['pr', 'merge', String(pr.number), '-R', full, flag], 90000);
        return { ok: true, action, message: `已用 ${mergeMethod} 合并 PR #${pr.number}` };
      }
      return { ok: false, code: 'bad-request', message: '未知操作' };
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/)[0] ?? '';
      return { ok: false, code: 'failed', message: detail.slice(0, 300) || 'gh 执行失败' };
    }
  }

  async function buildGithubSnapshot(projectSummaryData) {
    const repo = projectSummaryData.repo ? { owner: projectSummaryData.repo.split('/')[0], name: projectSummaryData.repo.split('/')[1] } : null;
    if (!projectSummaryData.git) return { available: false, status: 'not-git', repo: null };
    if (!repo) return { available: false, status: 'missing-remote', repo: null };
    const active = currentCredential();
    const branch = projectSummaryData.branch;
    const forgeRepo = forgeRepositoryFor(projectSummaryData.remote);
    const readiness = forgeRepo ? await forgeReadiness(forgeRepo) : null;
    const forgeReady = readiness?.state === 'ready';
    if (!active.value && !forgeReady) {
      return { available: false, status: 'missing-token', repo: `${repo.owner}/${repo.name}`, source: 'none' };
    }
    let prs = [];
    let restError = null;
    if (active.value) {
      try {
        const openPrs = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=20&sort=updated&direction=desc`);
        prs = Array.isArray(openPrs) ? openPrs : [];
      } catch (error) {
        restError = String(error?.message ?? error);
      }
    }
    if (prs.length === 0 && forgeReady && forgeRepo && branch) {
      try {
        const refs = await forge.findByHead(forgeRepo, branch, AbortSignal.timeout(HTTP_TIMEOUT_MS));
        prs = Array.isArray(refs)
          ? refs.map((ref) => ({ number: ref.number, title: '', head: { ref: branch }, html_url: forge.changeRequestUrl(ref) }))
          : [];
      } catch (error) {
        log(`forge findByHead failed: ${error?.message ?? error}`);
      }
    }
    const pr = prs.find((item) => item.head?.ref === branch) ?? null;
    const openPullRequests = prs.map((item) => ({
      number: item.number,
      title: item.title ?? '',
      headRef: item.head?.ref ?? '',
      htmlUrl: item.html_url ?? null,
      draft: Boolean(item.draft),
    }));

    // Preferred path: the official forge provider gives richer state and the
    // write actions (rerun / mark ready / update branch / merge).
    let forgeError = null;
    if (pr && forgeReady && forgeRepo) {
      try {
        const ref = { repository: forgeRepo, number: pr.number };
        const entry = await forgeUpdateFor(ref);
        const normalized = normalizeForgePr(entry.snapshot);
        normalized.runs = active.value ? await readRuns(repo, branch).catch(() => []) : [];
        normalized.files = active.value ? await readPrFiles(repo, pr.number) : [];
        normalized.reviewComments = active.value ? await readPrComments(repo, pr.number).catch(() => []) : [];
        return {
          available: true,
          status: 'ok',
          repo: `${repo.owner}/${repo.name}`,
          source: 'forge',
          branch,
          forge: { state: 'ready', message: readiness?.message ?? null },
          pr: normalized,
          openPullRequests,
          actions: forgeActions(entry.snapshot, normalized.checks),
        };
      } catch (error) {
        forgeError = String(error?.message ?? error);
        log(`forge snapshot failed, falling back to REST: ${forgeError}`);
      }
    }

    // REST fallback (no gh login / forge unavailable).
    try {
      const base = `/repos/${repo.owner}/${repo.name}`;
      let checks = { rollup: 'none', counts: { passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 }, items: [] };
      let runs = [];
      let reviews = { decision: 'none', latest: [] };
      let detail = null;
      let prFiles = [];
      let prComments = [];
      if (pr) {
        detail = await githubRequest(`${base}/pulls/${pr.number}`).catch(() => pr);
        const headSha = detail?.head?.sha ?? pr.head?.sha;
        [checks, runs, reviews, prFiles] = await Promise.all([
          headSha ? readChecks(repo, headSha) : checks,
          readRuns(repo, branch),
          githubRequest(`${base}/pulls/${pr.number}/reviews?per_page=100`).then(reviewDecisionFromReviews).catch(() => reviews),
          readPrFiles(repo, pr.number),
        ]);
        prComments = await readPrComments(repo, pr.number).catch(() => []);
      }
      const actions = restActions(
        pr
          ? {
              number: pr.number,
              draft: Boolean(detail?.draft ?? pr.draft),
              mergeableState: detail?.mergeable_state ?? null,
              checks,
            }
          : null,
        runs,
      );
      return {
        available: true,
        status: 'ok',
        repo: `${repo.owner}/${repo.name}`,
        source: 'rest',
        branch,
        forge: { state: readiness?.state ?? 'unavailable', message: forgeError || readiness?.message || null },
        pr: pr
          ? {
              number: pr.number,
              title: pr.title ?? '',
              state: detail?.state ?? pr.state ?? 'open',
              draft: Boolean(detail?.draft ?? pr.draft),
              merged: Boolean(detail?.merged ?? pr.merged),
              htmlUrl: detail?.html_url ?? pr.html_url ?? null,
              headRef: detail?.head?.ref ?? pr.head?.ref ?? branch,
              headSha: (detail?.head?.sha ?? pr.head?.sha ?? ''),
              baseRef: detail?.base?.ref ?? pr.base?.ref ?? '',
              mergeable: detail?.mergeable ?? null,
              mergeableState: detail?.mergeable_state ?? null,
              mergeReady: actions.merge.enabled,
              mergeMethods: actions.merge.methods,
              branchUpdates: actions.updateBranch.methods,
              reviewDecision: reviews.decision ?? 'none',
              reviewers: [],
              unresolvedThreads: null,
              author: detail?.user?.login ?? pr.user?.login ?? '',
              createdAt: pr.created_at ?? null,
              updatedAt: detail?.updated_at ?? pr.updated_at ?? null,
              changedFiles: detail?.changed_files ?? null,
              additions: detail?.additions ?? null,
              deletions: detail?.deletions ?? null,
              checks,
              reviews,
              runs,
              files: prFiles,
              reviewComments: prComments,
            }
          : null,
        openPullRequests,
        actions,
      };
    } catch (error) {
      const message = String(error?.message ?? restError ?? error);
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

  /* --------------------------------------------------- annotations & jobs */

  function ciStateDir(root) {
    return path.join(root, '.review', 'ci-review');
  }

  function annotationsPath(root) {
    return path.join(ciStateDir(root), 'annotations.json');
  }

  function readAnnotations(root) {
    const data = safeReadJson(annotationsPath(root));
    if (!Array.isArray(data?.annotations)) return [];
    return data.annotations.filter((item) => item && typeof item.file === 'string' && typeof item.body === 'string');
  }

  function writeAnnotations(root, annotations) {
    const dir = ciStateDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = annotationsPath(root);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, annotations }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    return annotations;
  }

  function taskDir(root) {
    return path.join(ciStateDir(root), 'tasks');
  }

  function readTasks(root) {
    const dir = taskDir(root);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    } catch {
      return [];
    }
    const tasks = [];
    for (const entry of entries) {
      const task = safeReadJson(path.join(dir, entry.name));
      if (task && typeof task.id === 'string') tasks.push(task);
    }
    return tasks.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))).slice(0, 20);
  }

  function writeTask(root, task) {
    const dir = taskDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${task.id}.json`);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  const activations = new Map();

  function resolveInsideRoot(root, relative) {
    if (typeof relative !== 'string' || !relative.trim()) return null;
    const normalized = relative.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('..')) return null;
    const resolved = path.resolve(root, normalized);
    const prefix = normalizePath(root);
    return normalizePath(resolved).startsWith(prefix) ? normalized : null;
  }

  function buildAgentPrompt({ project, brief, annotation }) {
    const target = annotation
      ? `${annotation.file}:${annotation.startLine ?? 1}${annotation.endLine ? `-${annotation.endLine}` : ''}`
      : brief.location
        ? `${brief.location.file}:${brief.location.startLine ?? 1}-${brief.location.endLine ?? brief.location.startLine ?? 1}`
        : '(not specified)';
    return [
      'You are a background revision subagent started by the DSH CI review workbench.',
      'Work independently in the given repository. Read the relevant files and context before editing.',
      '',
      'Task brief (JSON):',
      JSON.stringify(
        {
          project: project.name,
          repository: project.repo ?? null,
          branch: project.branch ?? null,
          target,
          instruction: brief.instruction,
          constraints: brief.constraints ?? 'Keep the API/format unchanged; make the smallest correct change.',
          allowedScope: brief.allowedScope ?? 'The files needed for this fix; stop and report if the change would exceed that.',
          acceptance: brief.acceptance ?? 'Run the project tests or the configured gate command when available.',
          riskBudget: brief.riskBudget ?? 'low',
        },
        null,
        2,
      ),
      '',
      'Rules:',
      '- Do not commit, push, merge, approve PRs, or resolve review threads.',
      '- Do not touch secrets, credentials, or files outside the repository.',
      '- If the request is ambiguous or would require a destructive/large change, stop and report status "blocked" with the exact question.',
      '',
      'When finished, reply with ONE JSON object and nothing else (no markdown fences around it), with this shape:',
      '{"status":"completed|blocked|failed","summary":"...","changes":[{"file":"...","locations":["L1-L2"],"summary":"...","rationale":"...","risk":{"level":"low|medium|high","notes":"..."}}],"consequences":{"behavior":"...","compatibility":"...","performance":"...","security":"...","userVisible":"..."},"tests":{"planned":["..."],"executed":[{"command":"...","exitCode":0,"summary":"..."}],"notRun":[{"command":"...","reason":"..."}]},"unresolved":["..."],"nextSteps":["..."],"confidence":"low|medium|high"}',
      '',
      'Report what actually happened. Never claim a test ran unless it ran.',
      '所有汇报内容（summary、changes、consequences、tests、unresolved、nextSteps）必须使用中文。',
    ].join('\n');
  }

  function parseAgentReport(result) {
    if (result && typeof result.structured === 'object' && result.structured) return result.structured;
    const text = (result?.output ?? [])
      .map((block) => (block && block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall back to the raw text */
      }
    }
    return { status: 'completed', summary: text || '(no report text)', changes: [], consequences: {}, tests: { planned: [], executed: [], notRun: [] } };
  }

  async function handleAnnotationAction(req, res, url) {
    const project = findProject(url.searchParams.get('projectId') ?? '');
    if (!project) return sendError(res, 404, 'unknown project');
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid JSON body');
    const action = String(body.action ?? 'create');
    const annotations = readAnnotations(project.root);
    if (action === 'create') {
      const file = resolveInsideRoot(project.root, String(body.file ?? ''));
      if (!file) return sendJson(res, 200, { ok: false, message: '文件路径必须位于项目根目录内' });
      const annotation = {
        id: randomBytes(8).toString('hex'),
        file,
        startLine: Number.isFinite(Number(body.startLine)) ? Math.max(1, Number(body.startLine)) : 1,
        endLine: Number.isFinite(Number(body.endLine)) ? Math.max(1, Number(body.endLine)) : null,
        body: String(body.body ?? '').slice(0, 8000),
        severity: ['info', 'warning', 'critical'].includes(body.severity) ? body.severity : 'warning',
        status: 'open',
        author: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!annotation.body.trim()) return sendJson(res, 200, { ok: false, message: '批注内容不能为空' });
      writeAnnotations(project.root, [annotation, ...annotations]);
      return sendJson(res, 200, { ok: true, annotation });
    }
    const id = String(body.id ?? '');
    const index = annotations.findIndex((item) => item.id === id);
    if (index < 0) return sendJson(res, 200, { ok: false, message: '找不到该批注' });
    if (action === 'update') {
      const next = { ...annotations[index], updatedAt: new Date().toISOString() };
      if (['open', 'addressed', 'wontfix'].includes(body.status)) next.status = body.status;
      if (typeof body.body === 'string' && body.body.trim()) next.body = body.body.slice(0, 8000);
      if (['info', 'warning', 'critical'].includes(body.severity)) next.severity = body.severity;
      annotations[index] = next;
      writeAnnotations(project.root, annotations);
      return sendJson(res, 200, { ok: true, annotation: next });
    }
    if (action === 'delete') {
      annotations.splice(index, 1);
      writeAnnotations(project.root, annotations);
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 400, 'unknown annotation action');
  }

  async function handleAgentTask(req, res, url) {
    const project = findProject(url.searchParams.get('projectId') ?? '');
    if (!project) return sendError(res, 404, 'unknown project');
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid JSON body');
    const instruction = String(body.instruction ?? '').trim();
    if (!instruction) return sendJson(res, 200, { ok: false, message: '请填写 Agent 指令' });
    const agentsSvc = (() => {
      try {
        return ctx.get('agents') ?? null;
      } catch {
        return null;
      }
    })();
    const subagents = (() => {
      try {
        return ctx.get('subagents') ?? null;
      } catch {
        return null;
      }
    })();
    if (!agentsSvc?.list || !subagents?.startActivation) {
      return sendJson(res, 200, { ok: false, message: '当前 profile 未提供 agent/subagent 服务' });
    }
    if (!subagents.getProvider?.('spawn')) {
      return sendJson(res, 200, { ok: false, message: '未找到 spawn subagent provider' });
    }
    const liveAgents = agentsSvc.list();
    let parent = null;
    const projectPrefix = normalizePath(project.root);
    for (const agent of liveAgents) {
      try {
        const candidateRoot = subagents.rootOf ? subagents.rootOf(agent) : agent;
        if (!candidateRoot?.id) continue;
        let cwd = '';
        try {
          const query = ctx.get('sessionQuery');
          const session = await query.readSession(candidateRoot.id);
          cwd = String(session?.header?.cwd ?? '');
        } catch {
          cwd = '';
        }
        parent = candidateRoot;
        if (cwd && normalizePath(cwd).startsWith(projectPrefix)) break;
      } catch {
        /* try the next live agent */
      }
    }
    if (!parent) return sendJson(res, 200, { ok: false, message: '没有可用的在线父会话，无法启动后台子代理' });
    const summary = projectSummary(project);
    const annotations = readAnnotations(project.root);
    const annotation = body.annotationId ? annotations.find((item) => item.id === body.annotationId) ?? null : null;
    let requestedTarget = null;
    if (body.target && typeof body.target === 'object' && body.target.file) {
      const file = resolveInsideRoot(project.root, String(body.target.file));
      if (!file) return sendJson(res, 200, { ok: false, message: '目标文件必须位于项目根目录内' });
      requestedTarget = {
        file,
        startLine: Number.isFinite(Number(body.target.startLine)) ? Math.max(1, Number(body.target.startLine)) : 1,
      };
    }
    const taskId = `agent-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    const task = {
      id: taskId,
      projectId: project.id,
      projectName: project.name,
      root: project.root,
      instruction,
      annotationId: annotation?.id ?? null,
      target: annotation
        ? { file: annotation.file, startLine: annotation.startLine, endLine: annotation.endLine }
        : requestedTarget,
      riskBudget: ['low', 'medium', 'high'].includes(body.riskBudget) ? body.riskBudget : 'low',
      status: 'running',
      childId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      report: null,
      error: null,
    };
    writeTask(project.root, task);
    try {
      const promptText = buildAgentPrompt({
        project: summary,
        brief: {
          instruction,
          constraints: body.constraints,
          allowedScope: body.allowedScope,
          acceptance: body.acceptance,
          riskBudget: task.riskBudget,
          location: task.target,
        },
        annotation,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('agent task timeout')), 40 * 60 * 1000);
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `ci-review ${taskId}`,
        name: `ci-review-${taskId.slice(-6)}`,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        cwd: project.root,
        signal: controller.signal,
        // Parent delivery keeps the child a durable DSH session (persisted,
        // openable from the panel) at the cost of one completion notice in the
        // parent conversation.
        delivery: 'parent',
      });
      activations.set(taskId, { activation, controller, timer });
      task.childId = activation.childId;
      task.status = 'running';
      writeTask(project.root, task);
      activation.result
        .then((result) => {
          task.status = result?.stopReason && result.stopReason !== 'completed' ? 'failed' : 'completed';
          task.report = parseAgentReport(result);
          task.stopReason = result?.stopReason ?? null;
          task.finishedAt = new Date().toISOString();
          writeTask(project.root, task);
        })
        .catch((error) => {
          task.status = 'failed';
          task.error = String(error?.message ?? error);
          task.finishedAt = new Date().toISOString();
          writeTask(project.root, task);
        })
        .finally(() => {
          const entry = activations.get(taskId);
          if (entry?.timer) clearTimeout(entry.timer);
          activations.delete(taskId);
          snapshotCache.delete(project.id);
        });
      snapshotCache.delete(project.id);
      return sendJson(res, 200, { ok: true, task });
    } catch (error) {
      task.status = 'failed';
      task.error = String(error?.message ?? error);
      task.finishedAt = new Date().toISOString();
      writeTask(project.root, task);
      return sendJson(res, 200, { ok: false, message: task.error, task });
    }
  }

  /* ------------------------------------------------------ review evidence */

  function readFindings(root, { limit = 600 } = {}) {
    const base = path.join(root, '.review', 'runs');
    let entries;
    try {
      entries = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, stat: fs.statSync(path.join(base, entry.name)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        .slice(0, 16);
    } catch {
      return [];
    }
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
      const aggregate = safeReadJson(path.join(base, entry.name, 'aggregate.json'));
      const findings = Array.isArray(aggregate?.findings) ? aggregate.findings : [];
      for (const finding of findings) {
        if (out.length >= limit) return out;
        if (!finding || !finding.file || finding.status === 'dropped') continue;
        const key = finding.fingerprint
          || `${finding.file}|${finding.startLine}|${finding.category}|${finding.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          file: String(finding.file),
          startLine: Number(finding.startLine) || 1,
          endLine: Number(finding.endLine) || Number(finding.startLine) || 1,
          severity: ['blocker', 'major', 'minor'].includes(finding.severity) ? finding.severity : 'minor',
          category: finding.category ?? '',
          title: finding.title ?? '',
          problem: String(finding.problem ?? '').slice(0, 1200),
          evidence: String(finding.evidence ?? '').slice(0, 1200),
          impact: String(finding.impact ?? '').slice(0, 800),
          suggestion: String(finding.suggestion ?? '').slice(0, 800),
          status: finding.status ?? 'real',
          runId: entry.name,
          existingCode: String(finding.existing_code ?? '').slice(0, 2000),
        });
      }
    }
    return out;
  }

  const SKIP_DIRS = new Set(['.git', 'node_modules', '.review', '.cache', 'coverage', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__']);

  function listProjectFiles(root, limit = 800) {
    const files = [];
    const queue = [''];
    while (queue.length > 0 && files.length < limit) {
      const relative = queue.shift();
      const absolute = relative ? path.join(root, relative) : root;
      let entries;
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= limit) break;
        const next = relative ? path.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          queue.push(next);
        } else if (entry.isFile()) {
          files.push(next.replace(/\\/g, '/'));
        }
      }
    }
    return files;
  }

  function priorityFiles(root, findings, annotations, changedFiles) {
    const byPath = new Map();
    const ensure = (file) => {
      if (!file) return null;
      const key = String(file).replace(/\\/g, '/');
      if (!byPath.has(key)) byPath.set(key, { path: key, findings: 0, blockers: 0, majors: 0, annotations: 0, changed: false });
      return byPath.get(key);
    };
    for (const finding of findings) {
      const row = ensure(finding.file);
      if (!row) continue;
      row.findings += 1;
      if (finding.severity === 'blocker') row.blockers += 1;
      else if (finding.severity === 'major') row.majors += 1;
    }
    for (const annotation of annotations) {
      const row = ensure(annotation.file);
      if (row) row.annotations += 1;
    }
    for (const file of changedFiles) {
      const row = ensure(file);
      if (row) row.changed = true;
    }
    return [...byPath.values()].sort((a, b) =>
      b.blockers - a.blockers || b.majors - a.majors || b.findings - a.findings || b.annotations - a.annotations
      || Number(b.changed) - Number(a.changed) || a.path.localeCompare(b.path));
  }

  function fileEntry(root, relative) {
    const resolved = path.resolve(root, relative);
    if (!normalizePath(resolved).startsWith(normalizePath(root))) return null;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    return { path: relative.replace(/\\/g, '/'), size: stat.size };
  }

  function hashText(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
  }

  function readProjectFile(root, relative) {
    const entry = fileEntry(root, relative);
    if (!entry) return null;
    if (entry.size > 400 * 1024) {
      return { ...entry, tooLarge: true, content: '', lines: 0, hash: '' };
    }
    try {
      const content = fs.readFileSync(path.resolve(root, relative), 'utf8');
      return { ...entry, tooLarge: false, content, lines: content.split('\n').length, hash: hashText(content) };
    } catch (error) {
      return { ...entry, tooLarge: false, content: '', lines: 0, hash: '', error: String(error?.message ?? error) };
    }
  }

  function readCardDecisions(root) {
    return safeReadJson(path.join(root, '.review', 'ci-review', 'cards.json'))?.decisions ?? {};
  }

  function writeCardDecisions(root, decisions) {
    const dir = path.join(root, '.review', 'ci-review');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cards.json'), `${JSON.stringify({ version: 1, decisions }, null, 2)}\n`, 'utf8');
  }

  function sourceExcerpt(root, file, startLine, pad = 6) {
    const data = readProjectFile(root, file);
    if (!data || data.tooLarge || typeof data.content !== 'string') return null;
    const lines = data.content.split('\n');
    const from = Math.max(1, (startLine || 1) - pad);
    const to = Math.min(lines.length, (startLine || 1) + pad);
    return { from, to, total: lines.length, lines: lines.slice(from - 1, to).map((text, index) => ({ n: from + index, text })) };
  }

  function buildReviewBatches(root, findings) {
    const decisions = readCardDecisions(root);
    const rank = { blocker: 0, major: 1, minor: 2 };
    const sorted = [...findings].sort((a, b) =>
      (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) || a.file.localeCompare(b.file) || (a.startLine || 1) - (b.startLine || 1));
    const size = 5;
    const batches = [];
    for (let start = 0; start < sorted.length; start += size) {
      const cards = sorted.slice(start, start + size).map((finding) => {
        const id = `${finding.file}#${finding.startLine}#${finding.category}`;
        return {
          id,
          file: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          problem: finding.problem,
          evidence: finding.evidence,
          impact: finding.impact,
          suggestion: finding.suggestion,
          runId: finding.runId,
          stale: !findingLineMatches(root, finding),
          excerpt: sourceExcerpt(root, finding.file, finding.startLine),
          decision: decisions[id]?.status === 'approved' ? 'approved'
            : decisions[id]?.status === 'needs-revision' ? 'needs-revision'
              : decisions[id]?.status === 'ignored' ? 'ignored' : 'pending',
          decisionSurface: {
            risk: finding.severity,
            blastRadius: 'single file (verify callers before changing signatures)',
            compatibility: finding.category === 'contract' ? 'public interface/format may change' : 'keep API/format stable',
            tests: finding.category === 'tests' ? 'add/adjust regression coverage' : 'run project gate after the fix',
            rollback: 'git diff / revert task files before commit',
          },
        };
      });
      const files = [...new Set(cards.map((card) => card.file))];
      batches.push({
        id: `batch-${batches.length + 1}`,
        index: batches.length + 1,
        cards,
        coverage: {
          files,
          count: cards.length,
          severities: cards.reduce((acc, card) => ({ ...acc, [card.severity]: (acc[card.severity] ?? 0) + 1 }), {}),
          categories: [...new Set(cards.map((card) => card.category))],
        },
        progress: {
          approved: cards.filter((card) => card.decision === 'approved').length,
          pending: cards.filter((card) => card.decision === 'pending').length,
        },
      });
    }
    return batches;
  }

  const PROBLEM_FAMILY = {
    correctness: 'logic', errors: 'logic', data: 'logic', concurrency: 'concurrency',
    security: 'security', contract: 'contract', intent: 'contract', tests: 'tests', style: 'style',
  };

  function findingLineMatches(root, finding) {
    const snippet = String(finding.existingCode ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    if (!snippet) return true;
    const probe = snippet.slice(0, 48);
    try {
      const content = fs.readFileSync(path.resolve(root, finding.file), 'utf8').split('\n');
      const start = Math.max(0, (Number(finding.startLine) || 1) - 3);
      const window = content.slice(start, start + 8).join('\n');
      return window.includes(probe);
    } catch {
      return false;
    }
  }

  function buildReviewProblems(root, findings) {
    const decisions = readCardDecisions(root);
    const verifications = readVerifications(root);
    const rank = { blocker: 0, major: 1, minor: 2 };
    const sorted = [...findings].sort((a, b) =>
      (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) || a.file.localeCompare(b.file) || (a.startLine || 1) - (b.startLine || 1));
    const problems = [];
    for (const finding of sorted) {
      const family = PROBLEM_FAMILY[finding.category] ?? 'logic';
      let problem = problems.find((item) =>
        item.family === family
        && item.files.includes(finding.file)
        && Math.abs(item.lastLine - (finding.startLine || 1)) <= 25);
      if (!problem) {
        problem = {
          id: '', family, lastLine: finding.startLine || 1,
          files: [], modules: [], categories: [],
          findings: [], severity: 'minor', title: finding.title, titles: [],
          what: finding.problem, whyImportant: finding.impact, evidence: finding.evidence,
        };
        problems.push(problem);
      }
      problem.lastLine = Math.max(problem.lastLine, finding.endLine || finding.startLine || 1);
      if (!problem.files.includes(finding.file)) problem.files.push(finding.file);
      if (!problem.categories.includes(finding.category)) problem.categories.push(finding.category);
      problem.findings.push(finding);
      const findingTitle = String(finding.title ?? '').trim();
      if (findingTitle && !problem.titles.includes(findingTitle)) problem.titles.push(findingTitle);
      if ((rank[finding.severity] ?? 2) < (rank[problem.severity] ?? 2)) {
        problem.severity = finding.severity;
        problem.title = finding.title;
        problem.what = finding.problem;
        problem.whyImportant = finding.impact;
        problem.evidence = finding.evidence;
      }
    }
    for (const [index, problem] of problems.entries()) {
      problem.id = `problem-${index + 1}-${problem.family}`;
      problem.modules = [...new Set(problem.files.map((file) => file.split('/').slice(0, -1).join('/') || '.'))];
      const cards = problem.findings.map((finding) => {
        const id = `${finding.file}#${finding.startLine}#${finding.category}`;
        return {
          id, kind: 'defect',
          file: finding.file, startLine: finding.startLine, endLine: finding.endLine,
          severity: finding.severity, category: finding.category, title: finding.title,
          problem: finding.problem, evidence: finding.evidence,
          impact: finding.impact, suggestion: finding.suggestion,
          runId: finding.runId,
          stale: !findingLineMatches(root, finding),
          excerpt: sourceExcerpt(root, finding.file, finding.startLine),
          decision: decisions[id]?.status === 'approved' ? 'approved'
            : decisions[id]?.status === 'needs-revision' ? 'needs-revision'
              : decisions[id]?.status === 'ignored' ? 'ignored' : 'pending',
          decisionSurface: {
            risk: finding.severity,
            blastRadius: 'verify callers of this location before changing behavior',
            compatibility: finding.category === 'contract' ? 'public interface/format may change' : 'keep API/format stable',
            tests: finding.category === 'tests' ? 'add/adjust regression coverage' : 'run project gate after the fix',
            rollback: 'git diff / revert task files before commit',
          },
        };
      });
      const pending = cards.filter((card) => card.decision === 'pending').length;
      problem.batch = {
        id: problem.id,
        index: index + 1,
        problemId: problem.id,
        phase: problem.modules.length > 1 ? 'cross-module' : 'core',
        title: problem.titles.length > 1 ? `${problem.title}（含 ${problem.titles.length - 1} 个相关问题）` : problem.title,
        titles: problem.titles,
        stale: cards.some((card) => card.stale),
        severity: problem.severity,
        category: problem.categories[0] ?? '',
        explanation: {
          what: problem.what, whyImportant: problem.whyImportant,
          evidence: problem.evidence,
          also: problem.titles.slice(1),
          uncertainty: problem.categories.includes('contract') ? '契约类问题需确认调用方与兼容策略' : '',
        },
        modules: problem.modules,
        coverage: {
          files: problem.files, modules: problem.modules,
          categories: problem.categories, findings: problem.findings.length,
          excluded: [], unknown: [],
        },
        cards,
        collapsed: (problem.severity === 'minor' && cards.length <= 2) || verifications[problem.id]?.verdict === 'rejected',
        verification: verifications[problem.id] ?? null,
        progress: { approved: cards.length - pending, pending },
      };
    }
    return problems.map((problem) => problem.batch).sort((a, b) =>
      (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) || a.modules.join().localeCompare(b.modules.join()) || a.index - b.index);
  }

  const vscodeBridge = { connected: false, workspaceRoot: '', updatedAt: null, buffers: {} };

  /* ------------------------------------------------ review annotation worktrees */

  function reviewWorktreeRoot() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'ci-review-worktrees');
  }

  function safeSlug(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'review';
  }

  function commentPrefixFor(file) {
    const ext = path.extname(file).toLowerCase();
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cs', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.swift', '.kt', '.scala'].includes(ext)) return '//';
    if (['.py', '.sh', '.bash', '.zsh', '.rb', '.yaml', '.yml', '.toml', '.ps1', '.r', '.pl'].includes(ext)) return '#';
    if (['.css', '.scss', '.less'].includes(ext)) return '/*';
    if (['.html', '.htm', '.xml', '.svg', '.md'].includes(ext)) return '<!--';
    return null;
  }

  function annotateText(text, file, cards) {
    const prefix = commentPrefixFor(file);
    if (!prefix) return { text, inserted: 0, unsupported: true };
    const lines = text.split('\n');
    let inserted = 0;
    const ordered = [...cards].filter((card) => card && Number.isFinite(Number(card.startLine)))
      .sort((a, b) => Number(b.startLine) - Number(a.startLine));
    for (const card of ordered) {
      const index = Math.max(0, Math.min(lines.length, Number(card.startLine) - 1));
      const indent = (lines[index] ?? '').match(/^\s*/)?.[0] ?? '';
      const marker = String(card.id ?? '');
      if (lines.some((line) => line.includes(`[ci-review:${marker}]`))) continue;
      const title = String(card.title ?? '问题位置').replace(/\r?\n/g, ' ').slice(0, 160);
      const reason = String(card.reason ?? '').replace(/\r?\n/g, ' ').slice(0, 200);
      const note = reason ? `${title} — ${reason}` : title;
      const comment = prefix === '<!--'
        ? `${indent}<!-- [ci-review:${marker}] ${note} -->`
        : prefix === '/*'
          ? `${indent}/* [ci-review:${marker}] ${note} */`
          : `${indent}${prefix} [ci-review:${marker}] ${note}`;
      lines.splice(index, 0, comment);
      inserted += 1;
    }
    return { text: lines.join('\n'), inserted, unsupported: false };
  }

  function reviewWorktreePath(project, name) {
    const base = safeSlug(project.name || path.basename(project.root));
    return path.join(reviewWorktreeRoot(), base, safeSlug(name));
  }

  async function createReviewWorktree({ project, name, cards }) {
    const dest = reviewWorktreePath(project, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const existing = annotateWorktree({ dest, cards });
      return { ok: true, path: dest, reused: true, ...existing };
    }
    execFileSync('git', ['-C', project.root, 'worktree', 'add', '--detach', dest, 'HEAD'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    const result = annotateWorktree({ dest, cards });
    return { ok: true, path: dest, reused: false, ...result };
  }

  function annotateWorktree({ dest, cards }) {
    const byFile = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
      const file = String(card?.file ?? '').replace(/\\/g, '/');
      if (!file) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(card);
    }
    const files = [];
    let inserted = 0;
    for (const [file, fileCards] of byFile) {
      const absolute = path.resolve(dest, file);
      if (!normalizePath(absolute).startsWith(normalizePath(dest))) continue;
      let text;
      try {
        text = fs.readFileSync(absolute, 'utf8');
      } catch {
        files.push({ file, error: 'not found in worktree' });
        continue;
      }
      const result = annotateText(text, file, fileCards);
      if (result.unsupported) {
        files.push({ file, unsupported: true });
        continue;
      }
      if (result.inserted > 0) fs.writeFileSync(absolute, result.text, 'utf8');
      files.push({ file, inserted: result.inserted });
      inserted += result.inserted;
    }
    let diffStat = '';
    try {
      diffStat = execFileSync('git', ['-C', dest, 'diff', '--stat'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
    } catch {
      diffStat = '';
    }
    return { files, inserted, diffStat };
  }

  function listReviewWorktrees(project) {
    const base = path.join(reviewWorktreeRoot(), safeSlug(project.name || path.basename(project.root)));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    return entries.map((name) => {
      const dir = path.join(base, name);
      let diffStat = '';
      try {
        diffStat = execFileSync('git', ['-C', dir, 'diff', '--stat'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
      } catch {
        diffStat = '';
      }
      return { name, path: dir, diffStat };
    });
  }

  function removeReviewWorktree({ project, name }) {
    const dir = reviewWorktreePath(project, name);
    if (!fs.existsSync(dir)) return { ok: true, removed: false };
    try {
      execFileSync('git', ['-C', project.root, 'worktree', 'remove', '--force', dir], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true, removed: true };
  }

  function fixQueuePath(root) {
    return path.join(root, '.review', 'ci-review', 'fix-queue.json');
  }

  function readFixQueue(root) {
    const data = safeReadJson(fixQueuePath(root));
    return Array.isArray(data?.items) ? data.items : [];
  }

  function writeFixQueue(root, items) {
    const dir = path.join(root, '.review', 'ci-review');
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${fixQueuePath(root)}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, fixQueuePath(root));
    return items;
  }

  function enqueueFixItems(root, cards, problemId) {
    const items = readFixQueue(root);
    const now = new Date().toISOString();
    for (const card of Array.isArray(cards) ? cards : []) {
      const id = String(card?.id ?? '');
      if (!id) continue;
      const existing = items.find((item) => item.id === id);
      const next = {
        id,
        problemId: card.problemId ?? problemId ?? null,
        file: String(card.file ?? ''),
        startLine: Number(card.startLine) || 1,
        title: String(card.title ?? '').slice(0, 300),
        severity: card.severity ?? 'minor',
        problem: String(card.problem ?? '').slice(0, 2000),
        status: existing?.status ?? 'queued',
        taskId: existing?.taskId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, next);
      else items.push(next);
    }
    return writeFixQueue(root, items);
  }

  function removeFixItems(root, cardIds) {
    const ids = new Set((Array.isArray(cardIds) ? cardIds : []).map(String));
    return writeFixQueue(root, readFixQueue(root).filter((item) => !ids.has(item.id)));
  }

  function updateFixItem(root, cardId, patch) {
    const items = readFixQueue(root);
    const item = items.find((entry) => entry.id === cardId);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    writeFixQueue(root, items);
    return item;
  }

  function verificationsPath(root) {
    return path.join(root, '.review', 'ci-review', 'verifications.json');
  }

  function readVerifications(root) {
    const data = safeReadJson(verificationsPath(root));
    return data && typeof data.byProblem === 'object' ? data.byProblem : {};
  }

  function writeVerifications(root, byProblem) {
    const dir = path.join(root, '.review', 'ci-review');
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${verificationsPath(root)}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, byProblem }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, verificationsPath(root));
    return byProblem;
  }

  function verificationPrompt(problem) {
    return [
      '你是独立问题验证子代理（另一个上下文，不是原始评审者）。请只读验证下面这个代码问题是否真实成立，不要修改任何文件。',
      '',
      '问题（JSON）：',
      JSON.stringify({
        file: problem.file,
        startLine: problem.startLine,
        severity: problem.severity,
        category: problem.category,
        title: problem.title,
        problem: problem.problem,
        evidence: problem.evidence,
      }, null, 2),
      '',
      '验证要求：',
      '1. 打开该文件与相关调用方，确认问题是否可复现；检查是否有反证（上游校验、调用约束、测试覆盖）。',
      '2. 只输出一个 JSON 对象（不要 markdown 围栏），字段：',
      '{"verdict":"confirmed|rejected|uncertain","reason":"中文理由","evidenceFor":["..."],"evidenceAgainst":["..."],"callSites":["file:line"],"confidence":"low|medium|high"}',
      '3. rejected 必须给出明确反证；uncertain 必须说明缺什么信息。',
    ].join('\n');
  }

  async function startVerification({ project, problem, parent, subagents }) {
    const taskId = `verify-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    const record = {
      id: taskId,
      problemId: String(problem.id ?? ''),
      status: 'running',
      verdict: null,
      reason: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      childId: null,
    };
    const byProblem = readVerifications(project.root);
    byProblem[record.problemId] = { ...record, history: [...(byProblem[record.problemId]?.history ?? []), record] };
    writeVerifications(project.root, byProblem);
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `verify ${taskId}`,
        name: `verify-${taskId.slice(-6)}`,
        prompt: [{ type: 'text', text: verificationPrompt(problem) }],
        parent,
        cwd: project.root,
        signal: AbortSignal.timeout(15 * 60 * 1000),
        delivery: 'caller',
      });
      byProblem[record.problemId] = { ...byProblem[record.problemId], childId: activation.childId };
      writeVerifications(project.root, byProblem);
      activation.result
        .then((result) => {
          const report = parseAgentReport(result);
          const entry = {
            ...byProblem[record.problemId],
            status: 'completed',
            verdict: ['confirmed', 'rejected', 'uncertain'].includes(report?.verdict) ? report.verdict : 'uncertain',
            reason: String(report?.reason ?? report?.summary ?? '').slice(0, 2000),
            evidenceFor: report?.evidenceFor ?? [],
            evidenceAgainst: report?.evidenceAgainst ?? [],
            callSites: report?.callSites ?? [],
            confidence: report?.confidence ?? null,
            finishedAt: new Date().toISOString(),
          };
          const latest = readVerifications(project.root);
          latest[record.problemId] = entry;
          writeVerifications(project.root, latest);
          snapshotCache.delete(project.id);
          if (entry.verdict === 'confirmed' && problem.severity === 'minor'
            && readCiReviewConfig(project.root).autoFixMinor === true) {
            void startAutoFix({
              project, parent, subagents, source: 'verification',
              problem: {
                id: problem.id, problemId: problem.id, file: problem.file, startLine: problem.startLine,
                severity: problem.severity, title: problem.title, problem: problem.problem,
              },
            });
          }
        })
        .catch((error) => {
          const latest = readVerifications(project.root);
          latest[record.problemId] = { ...latest[record.problemId], status: 'failed', error: String(error?.message ?? error), finishedAt: new Date().toISOString() };
          writeVerifications(project.root, latest);
          snapshotCache.delete(project.id);
        });
      snapshotCache.delete(project.id);
      return { ok: true, verification: byProblem[record.problemId] };
    } catch (error) {
      const latest = readVerifications(project.root);
      latest[record.problemId] = { ...latest[record.problemId], status: 'failed', error: String(error?.message ?? error) };
      writeVerifications(project.root, latest);
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  async function resolveVerificationParent(project) {
    const agentsSvc = (() => {
      try {
        return ctx.get('agents') ?? null;
      } catch {
        return null;
      }
    })();
    const subagents = (() => {
      try {
        return ctx.get('subagents') ?? null;
      } catch {
        return null;
      }
    })();
    if (!agentsSvc?.list || !subagents?.startActivation || !subagents?.rootOf) return { agentsSvc, subagents, parent: null };
    let parent = null;
    const prefix = normalizePath(project.root);
    for (const agent of agentsSvc.list()) {
      try {
        const candidate = subagents.rootOf(agent);
        if (!candidate?.id) continue;
        parent = candidate;
        let cwd = '';
        try {
          const query = ctx.get('sessionQuery');
          const session = await query.readSession(candidate.id);
          cwd = String(session?.header?.cwd ?? '');
        } catch {
          cwd = '';
        }
        if (cwd && normalizePath(cwd).startsWith(prefix)) break;
      } catch {
        /* try next */
      }
    }
    return { agentsSvc, subagents, parent };
  }

  /* ------------------------------------------------ multi-lens review jobs */

  function reviewJobsDir(root) {
    return path.join(root, '.review', 'ci-review', 'review-jobs');
  }

  function readReviewJobs(root) {
    const dir = reviewJobsDir(root);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 8);
    } catch {
      return [];
    }
    return files.map((name) => safeReadJson(path.join(dir, name))).filter((job) => job && job.id);
  }

  function writeReviewJob(root, job) {
    const dir = reviewJobsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    return job;
  }

  function agentJobFindings(root) {
    const jobs = readReviewJobs(root);
    const seen = new Set();
    const out = [];
    for (const job of jobs) {
      if (!job || job.status !== 'completed' || !job.results) continue;
      for (const [lens, result] of Object.entries(job.results)) {
        for (const finding of Array.isArray(result?.findings) ? result.findings : []) {
          if (!finding || !finding.file) continue;
          const key = `${finding.file}#${finding.startLine}#${finding.category || lens}#${finding.title || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            file: String(finding.file),
            startLine: Number(finding.startLine) || 1,
            endLine: Number(finding.endLine) || Number(finding.startLine) || 1,
            severity: ['blocker', 'major', 'minor'].includes(finding.severity) ? finding.severity : 'minor',
            category: String(finding.category || lens),
            title: String(finding.title ?? '').slice(0, 200),
            problem: String(finding.problem ?? '').slice(0, 1200),
            evidence: String(finding.evidence ?? '').slice(0, 1200),
            impact: String(finding.impact ?? '').slice(0, 800),
            suggestion: String(finding.suggestion ?? '').slice(0, 800),
            status: 'real',
            source: 'agent',
            lens,
            runId: `agent-job:${job.id}`,
          });
        }
      }
    }
    return out.slice(0, 300);
  }

  function reviewLensPrompt(file, lens) {
    return [
      `你是独立 ${lens} 视角的代码评审者（独立上下文，与其他评审者互相不可见）。`,
      `只读评审仓库文件 \`${file}\`（以及你需要的调用方/测试），不要修改任何文件。`,
      '',
      '输出要求：只输出一个 JSON 对象，不要 markdown 围栏：',
      '{"findings":[{"file":"...","startLine":1,"endLine":2,"severity":"blocker|major|minor","category":"correctness|errors|security|concurrency|data|contract|intent|tests|style","title":"...","problem":"...","evidence":"...","impact":"...","suggestion":"...","confidence":"low|medium|high"}]}',
      '最多 5 条，只报告你能用代码/调用方证明的真实问题；没有问题就返回 {"findings":[]}。',
      '不要报纯风格/测试增强建议；要给出具体行号与证据。',
    ].join('\n');
  }

  async function startReviewJob({ project, file, lenses, parent, subagents }) {
    const jobId = `job-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    const job = {
      id: jobId,
      file,
      lenses,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      results: Object.fromEntries(lenses.map((lens) => [lens, { status: 'running', findings: [] }])),
    };
    writeReviewJob(project.root, job);
    const update = (mutate) => {
      const current = safeReadJson(path.join(reviewJobsDir(project.root), `${jobId}.json`)) ?? job;
      mutate(current);
      const pending = Object.values(current.results ?? {}).some((result) => result?.status === 'running');
      current.status = pending ? 'running' : 'completed';
      if (!pending) current.finishedAt = new Date().toISOString();
      writeReviewJob(project.root, current);
      snapshotCache.delete(project.id);
    };
    for (const lens of lenses) {
      try {
        const activation = await subagents.startActivation({
          provider: 'spawn',
          label: `review-${lens} ${file}`,
          name: `rev-${jobId.slice(-6)}-${lens.slice(0, 6)}`,
          prompt: [{ type: 'text', text: reviewLensPrompt(file, lens) }],
          parent,
          cwd: project.root,
          signal: AbortSignal.timeout(20 * 60 * 1000),
          delivery: 'caller',
        });
        activation.result
          .then((result) => {
            const report = parseAgentReport(result);
            const findings = Array.isArray(report?.findings) ? report.findings : [];
            update((current) => {
              current.results[lens] = { status: 'completed', findings };
            });
          })
          .catch((error) => {
            update((current) => {
              current.results[lens] = { status: 'failed', error: String(error?.message ?? error), findings: [] };
            });
          });
      } catch (error) {
        update((current) => {
          current.results[lens] = { status: 'failed', error: String(error?.message ?? error), findings: [] };
        });
      }
    }
    snapshotCache.delete(project.id);
    return job;
  }

  function readCiReviewConfig(root) {
    const config = safeReadJson(path.join(root, '.review', 'config.json')) ?? {};
    return config?.ciReview && typeof config.ciReview === 'object' ? config.ciReview : {};
  }

  function autoFixPrompt(problem, gateCommands) {
    const gateText = gateCommands.length
      ? `修改后依次运行这些 gate 命令并记录结果：\n${gateCommands.map((command) => `- ${command}`).join('\n')}`
      : '项目没有配置 gate 命令；若改动 JS/TS，至少运行 `node --check <改动文件>` 自检。';
    return [
      '你是自动修复子代理（只处理下面这一个 minor 问题，不要扩散重构）。',
      '',
      '问题（JSON）：',
      JSON.stringify(problem, null, 2),
      '',
      '要求：',
      '1. 先读相关代码/调用方，确认根因后做最小修复；可以改代码和测试。',
      '2. 不要 commit / push / merge，不要改动与问题无关的文件。',
      '3. ' + gateText,
      '4. 只输出一个 JSON 对象（不要 markdown 围栏）：',
      '{"status":"fixed|not-fixed|blocked","reason":"中文说明","changes":["file:line"],"gate":{"passed":true,"commands":[{"command":"...","exitCode":0}]}}',
      '若无法安全修复或需要产品决策，返回 not-fixed/blocked 并说明原因。',
    ].join('\n');
  }

  const autoFixRunning = new Set();

  async function startAutoFix({ project, problem, parent, subagents, source = 'manual' }) {
    const cardId = String(problem.id ?? '');
    if (!cardId) return { ok: false, message: '缺少问题 id' };
    const items = enqueueFixItems(project.root, [{
      id: cardId,
      file: problem.file,
      startLine: problem.startLine,
      title: problem.title,
      severity: problem.severity ?? 'minor',
      problem: problem.problem,
      problemId: problem.problemId ?? null,
    }], problem.problemId ?? null);
    if (autoFixRunning.has(cardId)) return { ok: false, message: '该问题的自动修复已在运行' };
    autoFixRunning.add(cardId);
    const config = readCiReviewConfig(project.root);
    const max = Number(config.autoFixMaxPerRun) || 3;
    if (autoFixRunning.size > max) {
      autoFixRunning.delete(cardId);
      return { ok: false, message: `自动修复并发已达上限 ${max}` };
    }
    const gateConfig = safeReadJson(path.join(project.root, '.review', 'config.json')) ?? {};
    const gateCommands = (Array.isArray(gateConfig?.gate?.commands) ? gateConfig.gate.commands : [])
      .map((item) => (typeof item === 'string' ? item : item?.command))
      .filter((item) => typeof item === 'string' && item.trim());
    const updated = updateFixItem(project.root, cardId, {
      status: 'fixing',
      auto: true,
      autoSource: source,
      startedAt: new Date().toISOString(),
    });
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `autofix ${cardId}`,
        name: `fix-${String(cardId).slice(-8)}`,
        prompt: [{ type: 'text', text: autoFixPrompt({
          id: cardId, file: problem.file, startLine: problem.startLine,
          severity: problem.severity ?? 'minor', title: problem.title, problem: problem.problem,
        }, gateCommands) }],
        parent,
        cwd: project.root,
        signal: AbortSignal.timeout(20 * 60 * 1000),
        delivery: 'caller',
      });
      updateFixItem(project.root, cardId, { taskId: activation.childId });
      activation.result
        .then((result) => {
          const report = parseAgentReport(result);
          const gatePassed = report?.gate ? report.gate.passed === true : true;
          const fixed = report?.status === 'fixed' && gatePassed;
          updateFixItem(project.root, cardId, {
            status: fixed ? 'fixed' : 'queued',
            report: {
              status: report?.status ?? 'unknown',
              reason: String(report?.reason ?? '').slice(0, 2000),
              changes: Array.isArray(report?.changes) ? report.changes.slice(0, 50) : [],
              gate: report?.gate ?? null,
            },
            finishedAt: new Date().toISOString(),
          });
          autoFixRunning.delete(cardId);
          snapshotCache.delete(project.id);
        })
        .catch((error) => {
          updateFixItem(project.root, cardId, { status: 'queued', autoError: String(error?.message ?? error), finishedAt: new Date().toISOString() });
          autoFixRunning.delete(cardId);
          snapshotCache.delete(project.id);
        });
      snapshotCache.delete(project.id);
      return { ok: true, item: items.find((item) => item.id === cardId) ?? updated, taskId: activation.childId };
    } catch (error) {
      autoFixRunning.delete(cardId);
      updateFixItem(project.root, cardId, { status: 'queued', autoError: String(error?.message ?? error) });
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  /* ------------------------------------------------- completeness audit */

  function auditPath(root) {
    return path.join(root, '.review', 'ci-review', 'audit.json');
  }

  function readAudit(root) {
    const data = safeReadJson(auditPath(root));
    return data && typeof data === 'object' ? data : null;
  }

  function writeAudit(root, audit) {
    const dir = path.join(root, '.review', 'ci-review');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(auditPath(root), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
    return audit;
  }

  function auditPrompt({ batches, files, findingsCount }) {
    const summary = batches.map((batch) => ({
      id: batch.problemId,
      title: batch.title,
      severity: batch.severity,
      modules: batch.modules,
      cards: (batch.cards || []).length,
      files: [...new Set((batch.cards || []).map((card) => card.file))].slice(0, 10),
    }));
    return [
      '你是推送前完整性审计子代理（独立上下文）。已有审阅批次摘要和仓库文件清单如下，请审计是否存在遗漏或覆盖不足。',
      '',
      `原始 findings 数量：${findingsCount}`,
      '批次摘要（JSON）：',
      JSON.stringify(summary, null, 2).slice(0, 12000),
      '',
      '仓库文件清单（部分）：',
      JSON.stringify(files.slice(0, 120), null, 2).slice(0, 8000),
      '',
      '审计要求：',
      '1. 判断：是否有明显未被任何批次覆盖的高风险文件/模块；是否有 findings 未进入批次；批次说明是否缺少关键牵涉面。',
      '2. 只输出一个 JSON 对象（不要 markdown 围栏）：',
      '{"verdict":"complete|gaps","gaps":[{"kind":"missing-files|uncovered-findings|weak-batches","detail":"中文说明","files":["..."]}],"notes":"一段中文总结"}',
      '3. 不要修改任何文件；没有把握时用 gaps 并说明不确定点。',
    ].join('\n');
  }

  async function startAudit({ project, parent, subagents }) {
    const findings = [...agentJobFindings(project.root), ...readFindings(project.root)];
    const batches = buildReviewProblems(project.root, findings);
    const files = listProjectFiles(project.root, 400);
    const record = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      verdict: null,
      gaps: [],
      notes: '',
      batches: batches.length,
      findings: findings.length,
    };
    writeAudit(project.root, record);
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `audit ${project.name}`,
        name: `audit-${String(project.id).slice(-6)}`,
        prompt: [{ type: 'text', text: auditPrompt({ batches, files, findingsCount: findings.length }) }],
        parent,
        cwd: project.root,
        signal: AbortSignal.timeout(15 * 60 * 1000),
        delivery: 'caller',
      });
      activation.result
        .then((result) => {
          const report = parseAgentReport(result);
          const verdict = report?.verdict === 'complete' ? 'complete' : 'gaps';
          writeAudit(project.root, {
            ...record,
            status: 'completed',
            verdict,
            gaps: Array.isArray(report?.gaps) ? report.gaps.slice(0, 20) : [],
            notes: String(report?.notes ?? '').slice(0, 3000),
            finishedAt: new Date().toISOString(),
          });
          snapshotCache.delete(project.id);
        })
        .catch((error) => {
          writeAudit(project.root, { ...record, status: 'failed', error: String(error?.message ?? error), finishedAt: new Date().toISOString() });
          snapshotCache.delete(project.id);
        });
      snapshotCache.delete(project.id);
      return { ok: true, audit: record };
    } catch (error) {
      writeAudit(project.root, { ...record, status: 'failed', error: String(error?.message ?? error), finishedAt: new Date().toISOString() });
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  /* -------------------------------------------------------------- snapshot */

  async function buildSnapshot(project) {
    const summary = projectSummary(project);
    const [github, sessions] = await Promise.all([
      buildGithubSnapshot(summary),
      readSessions(project.root),
    ]);
    const localReviews = summary.exists ? readLocalReviewRuns(project.root) : [];
    const annotations = summary.exists ? readAnnotations(project.root) : [];
    const jobFindings = summary.exists ? agentJobFindings(project.root) : [];
    const findings = summary.exists ? [...jobFindings, ...readFindings(project.root)] : [];
    const reviewJobs = summary.exists ? readReviewJobs(project.root) : [];
    const changedPaths = Array.isArray(github.pr?.files) ? github.pr.files : [];
    const files = summary.exists ? priorityFiles(project.root, findings, annotations, changedPaths) : [];
    const repoUrl = summary.repo ? `https://github.com/${summary.repo}` : null;
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      project: summary,
      github,
      localReviews,
      sessions,
      vscode: { ...vscodeBridge },
      findings,
      files,
      fixQueue: summary.exists ? readFixQueue(project.root) : [],
      reviewJobs,
      audit: summary.exists ? readAudit(project.root) : null,
      reviewBatches: summary.exists ? buildReviewProblems(project.root, findings) : [],
      annotations,
      agentTasks: summary.exists ? readTasks(project.root) : [],
      capabilities: {
        openRepoUrl: repoUrl,
        openPrUrl: github.available && github.pr?.htmlUrl ? github.pr.htmlUrl : null,
        createPrUrl: summary.repo && summary.branch
          ? `https://github.com/${summary.repo}/compare/${encodeURIComponent(summary.branch)}?expand=1`
          : null,
        actionsUrl: summary.repo ? `${repoUrl}/actions` : null,
        canReadGithub: github.available,
        dataSource: github.source ?? 'none',
        forgeState: github.forge?.state ?? 'unavailable',
        prNumber: github.pr?.number ?? null,
        headSha: github.pr?.headSha ?? null,
        actions: github.actions ?? null,
      },
      links: { base: ROUTE },
    };
  }

  async function snapshotFor(project, { force = false } = {}) {
    const cached = snapshotCache.get(project.id);
    if (!force && cached && Date.now() - cached.at < refreshMs) return cached.snapshot;
    if (!force && !cached) {
      const disk = readDiskSnapshot(project.id);
      if (disk) {
        const instant = { ...disk, stale: true };
        snapshotCache.set(project.id, { at: 0, snapshot: instant });
        scheduleSnapshotRebuild(project);
        return instant;
      }
    }
    const snapshot = await buildSnapshot(project);
    storeSnapshot(project, snapshot);
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

  function readJsonBody(req, limit = 65536) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  function repoParts(repo) {
    if (!repo || typeof repo !== 'string' || !repo.includes('/')) return null;
    const [owner, name] = repo.split('/');
    return owner && name ? { owner, name } : null;
  }

  async function readRunDetail(repo, runId) {
    const ownerRepo = repoParts(repo);
    if (!ownerRepo) throw new Error('unknown repository');
    const data = await githubRequest(
      `/repos/${ownerRepo.owner}/${ownerRepo.name}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=50`,
    );
    return (Array.isArray(data.jobs) ? data.jobs : []).map((job) => ({
      id: job.id,
      name: job.name ?? '',
      status: job.status ?? 'unknown',
      conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      htmlUrl: job.html_url ?? null,
      steps: (Array.isArray(job.steps) ? job.steps : []).map((step) => ({
        number: step.number,
        name: step.name ?? '',
        status: step.status ?? 'unknown',
        conclusion: step.conclusion ?? null,
        startedAt: step.started_at ?? null,
        completedAt: step.completed_at ?? null,
      })),
    }));
  }

  async function handleAction(req, res, url) {
    const project = findProject(url.searchParams.get('projectId') ?? '');
    if (!project) return sendError(res, 404, 'unknown project');
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid JSON body');
    const action = String(body.action ?? '');
    const headSha = String(body.headSha ?? '');
    if (!headSha) return sendJson(res, 200, { ok: false, code: 'bad-request', message: '缺少 headSha，请刷新后重试' });
    const summary = projectSummary(project);
    let snapshot = snapshotCache.get(project.id)?.snapshot;
    if (!snapshot?.github?.pr) {
      snapshot = await buildSnapshot(project);
      snapshotCache.set(project.id, { at: Date.now(), snapshot });
    }
    const pr = snapshot.github?.pr;
    if (!pr) return sendJson(res, 200, { ok: false, code: 'no-pr', message: '当前分支没有打开的 PR' });
    if (pr.headSha !== headSha) {
      return sendJson(res, 200, { ok: false, code: 'stale', message: 'PR 的 head 已变化，请刷新后再操作' });
    }
    const forgeRepo = forgeRepositoryFor(summary.remote);
    let forgeReady = false;
    if (forgeRepo && forge && typeof forge.rerunChecks === 'function') {
      const readiness = await forgeReadiness(forgeRepo);
      forgeReady = readiness?.state === 'ready';
    }
    if (forgeReady) {
      const ref = { repository: forgeRepo, number: pr.number };
      const signal = AbortSignal.timeout(30000);
      try {
        let failure;
        if (action === 'rerun') {
          failure = await forge.rerunChecks(ref, { headSha }, signal);
        } else if (action === 'mark-ready') {
          failure = await forge.markReady(ref, signal);
        } else if (action === 'update-branch') {
          const method = body.method === 'rebase' ? 'rebase' : 'merge';
          failure = await forge.updateBranch(ref, { method, headSha }, signal);
        } else if (action === 'merge') {
          const method = ['merge', 'squash', 'rebase'].includes(body.method) ? body.method : 'squash';
          failure = await forge.merge(ref, { method, headSha }, signal);
        } else {
          return sendError(res, 400, 'unknown action');
        }
        if (failure) return sendJson(res, 200, { ok: false, code: failure.code, message: failure.message });
        try {
          forge.refresh(ref);
        } catch {
          /* next poll will still run */
        }
        snapshotCache.delete(project.id);
        return sendJson(res, 200, { ok: true, action, message: '已提交给 GitHub，稍后刷新查看结果' });
      } catch (error) {
        return sendJson(res, 200, { ok: false, code: 'unknown', message: String(error?.message ?? error) });
      }
    }
    // gh CLI fallback (Windows: the forge provider's GraphQL spawn is blocked by Node).
    const result = await runGhAction({ action, method: body.method, project, summary, pr, runs: pr.runs });
    snapshotCache.delete(project.id);
    return sendJson(res, 200, result);
  }

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/health`) {
      return sendJson(res, 200, { ok: true, plugin: name, refreshSeconds, tokenConfigured: Boolean(token) });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/bridge/config`) {
      writeBridgeDiscovery(hostPort(req));
      const host = String(req.headers.host ?? '');
      const portPart = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '80';
      return sendJson(res, 200, {
        ok: true,
        port: Number(portPart) || null,
        token,
        route: ROUTE,
        host,
      });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/projects`) {
      writeBridgeDiscovery(hostPort(req));
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
      writeBridgeDiscovery(hostPort(req));
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
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/action`) {
      return await handleAction(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/run`) {
      const projectIdParam = url.searchParams.get('projectId') ?? '';
      const runId = url.searchParams.get('runId') ?? '';
      const project = findProject(projectIdParam);
      if (!project) return sendError(res, 404, 'unknown project');
      if (!/^\d+$/.test(runId)) return sendError(res, 400, 'invalid runId');
      const summary = projectSummary(project);
      if (!summary.repo) return sendError(res, 400, 'project has no GitHub repository');
      if (!currentCredential().value) return sendError(res, 400, 'no GitHub credential');
      try {
        const jobs = await readRunDetail(summary.repo, runId);
        return sendJson(res, 200, {
          ok: true,
          runId: Number(runId),
          htmlUrl: `https://github.com/${summary.repo}/actions/runs/${runId}`,
          jobs,
        });
      } catch (error) {
        return sendError(res, 502, `读取运行详情失败：${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/debug-graph`) {
      let registry = null;
      try {
        registry = ctx.get('clientModules') ?? null;
      } catch {
        registry = null;
      }
      const id = '@local/dsh-ci-review';
      const graph = registry && typeof registry.graph === 'function' ? registry.graph() : null;
      return sendJson(res, 200, {
        ok: true,
        hasRegistry: Boolean(registry),
        clientPath: registry && typeof registry.clientPath === 'function' ? registry.clientPath(id) ?? null : null,
        entry: graph && Array.isArray(graph.entries) ? graph.entries.find((row) => row.id === id) ?? null : null,
        entries: graph && Array.isArray(graph.entries) ? graph.entries.map((row) => row.id) : [],
      });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/debug-reload-client`) {
      let registry = null;
      try {
        registry = ctx.get('clientModules') ?? null;
      } catch {
        registry = null;
      }
      const id = '@local/dsh-ci-review';
      let rev = null;
      try {
        rev = registry && typeof registry.rebuilt === 'function' ? registry.rebuilt(id) ?? null : null;
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
      }
      return sendJson(res, 200, { ok: Boolean(rev), id, rev });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/annotations`) {
      return await handleAnnotationAction(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/agent-task`) {
      return await handleAgentTask(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/agent-task/cancel`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const taskId = String(body?.taskId ?? '');
      const entry = activations.get(taskId);
      const tasks = readTasks(project.root);
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return sendJson(res, 200, { ok: false, message: '找不到该任务' });
      if (entry) {
        try {
          await entry.activation.dispose();
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: String(error?.message ?? error) });
        }
        if (entry.timer) clearTimeout(entry.timer);
        activations.delete(taskId);
      }
      task.status = 'cancelled';
      task.finishedAt = new Date().toISOString();
      writeTask(project.root, task);
      snapshotCache.delete(project.id);
      return sendJson(res, 200, { ok: true, task });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/files`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'priority';
      const summary = projectSummary(project);
      const annotations = readAnnotations(project.root);
      const findings = readFindings(project.root);
      if (mode === 'priority') {
        const cached = snapshotCache.get(project.id)?.snapshot;
        const changed = Array.isArray(cached?.github?.pr?.files) ? cached.github.pr.files : [];
        return sendJson(res, 200, { ok: true, mode, files: priorityFiles(project.root, findings, annotations, changed) });
      }
      const paths = listProjectFiles(project.root);
      const priority = new Map(priorityFiles(project.root, findings, annotations, []).map((row) => [row.path, row]));
      const files = paths.map((file) => priority.get(file) ?? { path: file, findings: 0, blockers: 0, majors: 0, annotations: 0, changed: false });
      return sendJson(res, 200, { ok: true, mode, files, total: files.length, summary: { root: summary.root } });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/file`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const relative = url.searchParams.get('path') ?? '';
      if (!resolveInsideRoot(project.root, relative)) return sendError(res, 400, 'path must stay inside the project root');
      const file = readProjectFile(project.root, relative);
      if (!file) return sendError(res, 404, 'file not found');
      return sendJson(res, 200, { ok: true, file });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/projects/add`) {
      const body = await readJsonBody(req);
      const rootInput = String(body?.root ?? '').trim();
      if (!rootInput) return sendJson(res, 200, { ok: false, message: '请填写项目根目录路径' });
      let resolved;
      try {
        resolved = fs.realpathSync(path.resolve(rootInput));
      } catch {
        return sendJson(res, 200, { ok: false, message: '目录不存在或不可访问' });
      }
      let stat = null;
      try {
        stat = fs.statSync(resolved);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) return sendJson(res, 200, { ok: false, message: '不是一个目录' });
      const name = String(body?.name ?? '').trim() || path.basename(resolved);
      const existing = readExtraProjects().filter((entry) => normalizePath(entry.root) !== normalizePath(resolved));
      existing.push({ root: resolved, name });
      writeExtraProjects(existing);
      return sendJson(res, 200, { ok: true, project: { id: projectId(resolved), name, root: resolved, source: 'imported' } });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/projects/remove`) {
      const body = await readJsonBody(req);
      const root = String(body?.root ?? '').trim();
      const resolved = (() => {
        try {
          return fs.realpathSync(path.resolve(root));
        } catch {
          return path.resolve(root);
        }
      })();
      const kept = readExtraProjects().filter((entry) => normalizePath(entry.root) !== normalizePath(resolved));
      writeExtraProjects(kept);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/agent-task/messages`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const taskId = url.searchParams.get('taskId') ?? '';
      const task = readTasks(project.root).find((item) => item.id === taskId);
      if (!task || !task.childId) return sendJson(res, 200, { ok: false, message: '该任务还没有子会话' });
      const query = (() => {
        try {
          return ctx.get('sessionQuery') ?? null;
        } catch {
          return null;
        }
      })();
      if (!query || typeof query.readSession !== 'function') {
        return sendJson(res, 200, { ok: false, message: 'sessionQuery 不可用，无法读取子会话消息' });
      }
      try {
        const diagnostics = { readSession: null, inspectSession: null, observeSession: null, listed: null };
        let events = [];
        const take = (session) => (session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []);
        try {
          const session = await query.readSession(task.childId);
          diagnostics.readSession = take(session).length;
          events = take(session);
        } catch (error) {
          diagnostics.readSession = `error: ${String(error?.message ?? error).slice(0, 120)}`;
        }
        if (events.length === 0 && typeof query.inspectSession === 'function') {
          try {
            const inspected = await query.inspectSession(task.childId, (session) => take(session));
            diagnostics.inspectSession = Array.isArray(inspected) ? inspected.length : -1;
            if (Array.isArray(inspected) && inspected.length > 0) events = inspected;
          } catch (error) {
            diagnostics.inspectSession = `error: ${String(error?.message ?? error).slice(0, 120)}`;
          }
        }
        if (events.length === 0 && typeof query.observeSession === 'function') {
          try {
            const observation = await query.observeSession(task.childId, {});
            const session = observation?.session ?? observation?.lease?.session ?? observation;
            diagnostics.observeSession = take(session).length;
            if (take(session).length > 0) events = take(session);
          } catch (error) {
            diagnostics.observeSession = `error: ${String(error?.message ?? error).slice(0, 120)}`;
          }
        }
        if (typeof query.listSessions === 'function') {
          try {
            const rows = await query.listSessions();
            diagnostics.listed = Array.isArray(rows)
              ? rows.filter((row) => String(row?.id ?? row?.sessionId ?? row?.header?.id ?? '') === task.childId).length
              : -1;
          } catch (error) {
            diagnostics.listed = `error: ${String(error?.message ?? error).slice(0, 120)}`;
          }
        }
        const types = {};
        const rows = [];
        for (const event of events) {
          const type = event?.type;
          if (typeof type === 'string') types[type] = (types[type] ?? 0) + 1;
          if (type !== 'user/message' && type !== 'assistant/message') continue;
          const data = event?.data ?? {};
          const message = type === 'assistant/message' ? (data.message ?? {}) : (data.message ?? data);
          const blocks = Array.isArray(message?.content)
            ? message.content
            : Array.isArray(data?.content)
              ? data.content
              : [];
          const text = blocks
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim();
          if (text) rows.push({ role: type === 'user/message' ? 'user' : 'assistant', text, time: event.time ?? null });
        }
        return sendJson(res, 200, {
          ok: true,
          messages: rows.slice(-30),
          events: events.length,
          diagnostics,
          types,
          running: task.status === 'running',
        });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: `读取子会话失败：${String(error?.message ?? error).slice(0, 200)}` });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/agent-task/message`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const taskId = String(body?.taskId ?? '');
      const text = String(body?.message ?? '').trim();
      if (!text) return sendJson(res, 200, { ok: false, message: '消息不能为空' });
      const task = readTasks(project.root).find((item) => item.id === taskId);
      if (!task || !task.childId) return sendJson(res, 200, { ok: false, message: '该任务还没有子会话' });
      const agentsSvc = (() => {
        try {
          return ctx.get('agents') ?? null;
        } catch {
          return null;
        }
      })();
      const subagents = (() => {
        try {
          return ctx.get('subagents') ?? null;
        } catch {
          return null;
        }
      })();
      if (!agentsSvc?.list || !subagents?.sendMessage || !subagents?.rootOf) {
        return sendJson(res, 200, { ok: false, message: '当前 profile 不支持给子会话发消息' });
      }
      let root = null;
      for (const agent of agentsSvc.list()) {
        try {
          const candidate = subagents.rootOf(agent);
          if (candidate?.id) {
            root = candidate;
            break;
          }
        } catch {
          /* try the next agent */
        }
      }
      if (!root) return sendJson(res, 200, { ok: false, message: '没有可用在线根会话，请先打开一个 DSH 会话' });
      try {
        await subagents.sendMessage({
          sender: root,
          targetId: task.childId,
          content: [{ type: 'text', text }],
          options: { signal: AbortSignal.timeout(30000) },
        });
        return sendJson(res, 200, { ok: true, message: '消息已发送给子会话，稍后刷新对话即可看到进度' });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: `发送失败：${String(error?.message ?? error).slice(0, 200)}` });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-cards/decide`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const status = ['approved', 'needs-revision', 'ignored', 'pending'].includes(body?.status) ? body.status : 'pending';
      const decisions = readCardDecisions(project.root);
      const ids = Array.isArray(body?.cardIds) ? body.cardIds.map(String) : [String(body?.cardId ?? '')];
      for (const id of ids.filter(Boolean)) {
        if (status === 'pending') delete decisions[id];
        else decisions[id] = { status, at: new Date().toISOString() };
      }
      writeCardDecisions(project.root, decisions);
      if (status === 'approved' && Array.isArray(body?.cards)) {
        enqueueFixItems(project.root, body.cards, body?.problemId);
      }
      if (status === 'ignored' || status === 'needs-revision' || status === 'pending') {
        removeFixItems(project.root, ids);
      }
      snapshotCache.delete(project.id);
      return sendJson(res, 200, { ok: true, updated: ids.length, status });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/gate/config`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const configPath = path.join(project.root, '.review', 'config.json');
      const config = safeReadJson(configPath) ?? {};
      const raw = config?.gate?.commands;
      const commands = Array.isArray(raw)
        ? raw.map((item) => (typeof item === 'string' ? item : item?.command)).filter((item) => typeof item === 'string' && item.trim())
        : [];
      return sendJson(res, 200, { ok: true, source: fs.existsSync(configPath) ? 'config' : 'missing', commands });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/gate/run`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const config = safeReadJson(path.join(project.root, '.review', 'config.json')) ?? {};
      const raw = Array.isArray(body?.commands) && body.commands.length > 0 ? body.commands : config?.gate?.commands;
      const commands = (Array.isArray(raw) ? raw : [])
        .map((item) => (typeof item === 'string' ? item : item?.command))
        .filter((item) => typeof item === 'string' && item.trim());
      if (commands.length === 0) return sendJson(res, 200, { ok: false, message: '没有 gate 命令：请配置 .review/config.json 的 gate.commands 或临时指定' });
      const results = [];
      for (const command of commands) {
        const started = Date.now();
        try {
          const stdout = execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', command] : ['-lc', command], {
            cwd: project.root, encoding: 'utf8', timeout: 120000, windowsHide: true,
            windowsVerbatimArguments: process.platform === 'win32',
            env: { ...process.env, CI: '1' },
          });
          results.push({ command, exitCode: 0, durationMs: Date.now() - started, output: String(stdout).slice(-4000) });
        } catch (error) {
          results.push({
            command,
            exitCode: Number.isInteger(error?.status) ? error.status : 1,
            durationMs: Date.now() - started,
            output: `${String(error?.stdout ?? '')}\n${String(error?.stderr ?? error?.message ?? '')}`.slice(-4000),
          });
        }
      }
      return sendJson(res, 200, { ok: results.every((item) => item.exitCode === 0), results });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/agent-task/diff`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const task = readTasks(project.root).find((item) => item.id === (url.searchParams.get('taskId') ?? ''));
      if (!task) return sendJson(res, 200, { ok: false, message: '找不到该任务' });
      const files = Array.isArray(task.report?.changes)
        ? task.report.changes.map((change) => change?.file).filter((file) => typeof file === 'string')
        : [];
      try {
        const args = ['-C', project.root, 'diff', '--no-color'];
        if (files.length > 0) args.push('--', ...files);
        const diff = execFileSync('git', args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
        return sendJson(res, 200, { ok: true, files, diff: diff.slice(0, 200000), truncated: diff.length > 200000 });
      } catch (error) {
        return sendJson(res, 200, { ok: false, files, message: String(error?.message ?? error).slice(0, 200) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/vscode/push`) {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid JSON body');
      vscodeBridge.connected = true;
      vscodeBridge.updatedAt = new Date().toISOString();
      const applyPayload = (payload) => {
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'hello') {
          vscodeBridge.workspaceRoot = String(payload.workspaceRoot ?? '');
          return;
        }
        if (payload.type !== 'buffer' || typeof payload.file !== 'string') return;
        const incomingVersion = Number(payload.version) || 0;
        const incomingSession = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const previous = vscodeBridge.buffers[payload.file];
        // Out-of-order guard only within one editor session: a new VS Code
        // session restarts document versions from 1, which must not be treated
        // as a stale payload.
        if (previous && previous.sessionId && incomingSession === previous.sessionId
          && incomingVersion > 0 && previous.version > 0 && incomingVersion < previous.version) return;
        vscodeBridge.buffers[payload.file] = {
          file: payload.file,
          sessionId: incomingSession,
          absPath: typeof payload.absPath === 'string' ? payload.absPath : '',
          languageId: payload.languageId ?? '',
          version: incomingVersion,
          dirty: Boolean(payload.dirty),
          truncated: Boolean(payload.truncated),
          semantics: payload.semantics && typeof payload.semantics === 'object'
            ? payload.semantics
            : previous?.semantics ?? null,
          lines: Array.isArray(payload.lines) ? payload.lines.slice(0, 3000) : [],
          diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics.slice(0, 200) : [],
          updatedAt: new Date().toISOString(),
        };
      };
      if (body.type === 'batch' && Array.isArray(body.buffers)) {
        for (const payload of body.buffers) applyPayload(payload);
      } else {
        applyPayload(body);
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/pr/comment`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const file = String(body?.file ?? '').replace(/\\/g, '/');
      const line = Number(body?.line);
      const text = String(body?.body ?? '').trim();
      if (!file || !Number.isFinite(line) || line < 1 || !text) return sendJson(res, 200, { ok: false, message: 'file/line/body 必填' });
      let snapshot = snapshotCache.get(project.id)?.snapshot;
      if (!snapshot?.github?.pr) {
        snapshot = await buildSnapshot(project);
        snapshotCache.set(project.id, { at: Date.now(), snapshot });
      }
      const pr = snapshot.github?.pr;
      if (!pr) return sendJson(res, 200, { ok: false, message: '当前分支没有打开的 PR' });
      if (!pr.headSha) return sendJson(res, 200, { ok: false, message: '缺少 PR headSha' });
      const summary = projectSummary(project);
      const repo = repoParts(summary.repo);
      if (!repo) return sendJson(res, 200, { ok: false, message: '项目没有 GitHub 仓库' });
      try {
        const comment = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`, {
          method: 'POST',
          body: { body: text, commit_id: pr.headSha, path: file, line, side: body?.side === 'LEFT' ? 'LEFT' : 'RIGHT' },
        });
        snapshotCache.delete(project.id);
        return sendJson(res, 200, { ok: true, url: comment?.html_url ?? null, id: comment?.id ?? null });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 240) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/pr/review`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const event = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(body?.event) ? body.event : '';
      if (!event) return sendJson(res, 200, { ok: false, message: 'event 必须是 APPROVE/REQUEST_CHANGES/COMMENT' });
      const text = String(body?.body ?? '').trim();
      if (event !== 'APPROVE' && !text) return sendJson(res, 200, { ok: false, message: '该 review 类型必须填写内容' });
      let snapshot = snapshotCache.get(project.id)?.snapshot;
      if (!snapshot?.github?.pr) {
        snapshot = await buildSnapshot(project);
        snapshotCache.set(project.id, { at: Date.now(), snapshot });
      }
      const pr = snapshot.github?.pr;
      if (!pr) return sendJson(res, 200, { ok: false, message: '当前分支没有打开的 PR' });
      const summary = projectSummary(project);
      const repo = repoParts(summary.repo);
      if (!repo) return sendJson(res, 200, { ok: false, message: '项目没有 GitHub 仓库' });
      try {
        const review = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/reviews`, {
          method: 'POST',
          body: { event, body: text || undefined, commit_id: pr.headSha || undefined },
        });
        snapshotCache.delete(project.id);
        return sendJson(res, 200, { ok: true, url: review?.html_url ?? null, state: review?.state ?? event });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 240) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/pr/merge`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const method = ['squash', 'merge', 'rebase'].includes(body?.method) ? body.method : 'squash';
      let snapshot = snapshotCache.get(project.id)?.snapshot;
      if (!snapshot?.github?.pr) {
        snapshot = await buildSnapshot(project);
        snapshotCache.set(project.id, { at: Date.now(), snapshot });
      }
      const pr = snapshot.github?.pr;
      if (!pr) return sendJson(res, 200, { ok: false, message: '当前分支没有打开的 PR' });
      if (pr.state === 'closed' || pr.merged) return sendJson(res, 200, { ok: false, message: 'PR 已关闭或已合并' });
      const summary = projectSummary(project);
      const repo = repoParts(summary.repo);
      if (!repo) return sendJson(res, 200, { ok: false, message: '项目没有 GitHub 仓库' });
      try {
        const merged = await githubRequest(`/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/merge`, {
          method: 'PUT',
          body: { merge_method: method, sha: pr.headSha || undefined },
        });
        snapshotCache.delete(project.id);
        return sendJson(res, 200, { ok: Boolean(merged?.merged), merged: Boolean(merged?.merged), message: merged?.message ?? '' });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 240) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/bridge/open-vscode`) {
      try {
        if (process.platform === 'win32') {
          execFileSync('cmd', ['/c', 'start', '""', 'code'], { windowsVerbatimArguments: true, windowsHide: true, timeout: 15000 });
        } else if (process.platform === 'darwin') {
          execFileSync('open', ['-a', 'Visual Studio Code'], { timeout: 15000 });
        } else {
          execFileSync('code', [], { timeout: 15000 });
        }
        return sendJson(res, 200, { ok: true, launched: true, discovery: writeBridgeDiscovery() });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 200) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-worktree/create`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const name = safeSlug(body?.name || 'review');
      const cards = Array.isArray(body?.cards) ? body.cards : [];
      try {
        const result = await createReviewWorktree({ project, name, cards });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 300) });
      }
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/review-worktree/list`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      return sendJson(res, 200, { ok: true, worktrees: listReviewWorktrees(project) });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-worktree/remove`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, removeReviewWorktree({ project, name: String(body?.name ?? '') }));
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 300) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/file/save`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const relative = resolveInsideRoot(project.root, String(body?.path ?? ''));
      if (!relative) return sendJson(res, 200, { ok: false, message: '文件路径必须位于项目根目录内' });
      const absolute = path.resolve(project.root, relative);
      let current = '';
      try {
        current = fs.readFileSync(absolute, 'utf8');
      } catch {
        current = '';
      }
      const currentHash = hashText(current);
      if (body?.expectedHash && body.expectedHash !== currentHash) {
        return sendJson(res, 200, {
          ok: false, code: 'stale', message: '文件已在磁盘上被修改，请重新加载后再保存', hash: currentHash,
        });
      }
      if (typeof body?.content !== 'string') return sendJson(res, 200, { ok: false, message: '缺少 content' });
      const backupDir = path.join(project.root, '.review', 'ci-review', 'backups', new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15) + '-' + randomBytes(3).toString('hex'));
      let backupPath = null;
      if (current) {
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          const backupFile = path.join(backupDir, relative.replace(/[\\/]/g, '__'));
          fs.writeFileSync(backupFile, current, 'utf8');
          backupPath = backupFile;
        } catch {
          backupPath = null;
        }
      }
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        const temp = `${absolute}.ci-review-tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temp, body.content, 'utf8');
        fs.renameSync(temp, absolute);
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: `写入失败：${String(error?.message ?? error).slice(0, 200)}` });
      }
      const nextHash = hashText(body.content);
      snapshotCache.delete(project.id);
      return sendJson(res, 200, {
        ok: true,
        path: relative,
        hash: nextHash,
        backupPath,
        lines: body.content.split('\n').length,
      });
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE}/api/fix-queue`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      return sendJson(res, 200, { ok: true, items: readFixQueue(project.root) });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/fix-queue/update`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const id = String(body?.id ?? '');
      if (!id) return sendJson(res, 200, { ok: false, message: '缺少 id' });
      if (body?.status === 'removed') {
        removeFixItems(project.root, [id]);
        snapshotCache.delete(project.id);
        return sendJson(res, 200, { ok: true, removed: true });
      }
      const item = updateFixItem(project.root, id, {
        status: ['queued', 'fix-started', 'fixed', 'verified'].includes(body?.status) ? body.status : 'queued',
        taskId: body?.taskId ?? undefined,
      });
      snapshotCache.delete(project.id);
      return sendJson(res, 200, item ? { ok: true, item } : { ok: false, message: '找不到队列项' });
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-problems/verify`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const problem = body?.problem;
      if (!problem || !problem.id || !problem.file) return sendJson(res, 200, { ok: false, message: '缺少 problem 信息' });
      const { parent, subagents } = await resolveVerificationParent(project);
      if (!parent || !subagents) return sendJson(res, 200, { ok: false, message: '没有可用在线会话，无法启动验证子代理' });
      const result = await startVerification({ project, problem, parent, subagents });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-job/start`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const file = resolveInsideRoot(project.root, String(body?.file ?? ''));
      if (!file) return sendJson(res, 200, { ok: false, message: '文件必须在项目根目录内' });
      const allowed = ['intent', 'correctness', 'errors', 'security', 'concurrency', 'data', 'contract', 'tests'];
      const lenses = (Array.isArray(body?.lenses) ? body.lenses : ['correctness', 'errors', 'security'])
        .filter((lens) => allowed.includes(lens));
      if (lenses.length === 0) return sendJson(res, 200, { ok: false, message: '至少选择一个视角' });
      const { parent, subagents } = await resolveVerificationParent(project);
      if (!parent || !subagents) return sendJson(res, 200, { ok: false, message: '没有可用在线会话，无法启动评审子代理' });
      try {
        const job = await startReviewJob({ project, file, lenses, parent, subagents });
        return sendJson(res, 200, { ok: true, job });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/lsp/query`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const file = resolveInsideRoot(project.root, String(body?.file ?? ''));
      if (!file) return sendJson(res, 200, { ok: false, message: '文件必须在项目根目录内' });
      const operation = ['hover', 'goToDefinition', 'findReferences', 'goToImplementation'].includes(body?.operation)
        ? body.operation
        : 'hover';
      const line = Math.max(0, (Number(body?.line) || 1) - 1);
      const character = Math.max(0, Number(body?.character) || 0);
      let service = null;
      try {
        service = ctx.get('lsp') ?? null;
      } catch {
        service = null;
      }
      if (!service?.query) return sendJson(res, 200, { ok: false, message: '当前 DSH 没有 LSP 服务' });
      try {
        const result = await service.query({
          operation,
          filePath: path.resolve(project.root, file),
          position: { line, character },
          workspaceRoot: project.root,
        }, AbortSignal.timeout(12000));
        if (result?.kind === 'hover') {
          return sendJson(res, 200, { ok: true, kind: 'hover', hover: result.hover ?? null, operation });
        }
        return sendJson(res, 200, {
          ok: true,
          kind: 'locations',
          operation,
          locations: (result?.locations ?? []).slice(0, 50),
        });
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 300) });
      }
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/fix-queue/auto-fix`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const problem = body?.problem;
      if (!problem || !problem.id || !problem.file) return sendJson(res, 200, { ok: false, message: '缺少 problem 信息' });
      const { parent, subagents } = await resolveVerificationParent(project);
      if (!parent || !subagents) return sendJson(res, 200, { ok: false, message: '没有可用在线会话，无法启动自动修复' });
      const result = await startAutoFix({ project, problem, parent, subagents, source: 'manual' });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review/audit`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const { parent, subagents } = await resolveVerificationParent(project);
      if (!parent || !subagents) return sendJson(res, 200, { ok: false, message: '没有可用在线会话，无法启动完整性审计' });
      const result = await startAudit({ project, parent, subagents });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === `${ROUTE}/api/review-job/start-batch`) {
      const project = findProject(url.searchParams.get('projectId') ?? '');
      if (!project) return sendError(res, 404, 'unknown project');
      const body = await readJsonBody(req);
      const files = (Array.isArray(body?.files) ? body.files : [])
        .map((file) => resolveInsideRoot(project.root, String(file)))
        .filter(Boolean)
        .slice(0, 5);
      if (files.length === 0) return sendJson(res, 200, { ok: false, message: '没有可评审的文件' });
      const allowed = ['intent', 'correctness', 'errors', 'security', 'concurrency', 'data', 'contract', 'tests'];
      const lenses = (Array.isArray(body?.lenses) ? body.lenses : ['correctness', 'errors'])
        .filter((lens) => allowed.includes(lens));
      const { parent, subagents } = await resolveVerificationParent(project);
      if (!parent || !subagents) return sendJson(res, 200, { ok: false, message: '没有可用在线会话，无法启动评审子代理' });
      const jobs = [];
      for (const file of files) {
        try {
          jobs.push(await startReviewJob({ project, file, lenses: lenses.length ? lenses : ['correctness'], parent, subagents }));
        } catch (error) {
          jobs.push({ file, error: String(error?.message ?? error) });
        }
      }
      snapshotCache.delete(project.id);
      return sendJson(res, 200, { ok: true, jobs });
    }
    return sendError(res, 404, 'unknown ci-review API route');
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      if (!url.pathname.startsWith(ROUTE)) return sendError(res, 404, 'not found');
      // Public, loopback-only discovery endpoints for the IDE bridge. They never
      // expose repository data; the pair call exists so a local IDE extension can
      // connect without persisting a token in user settings.
      if (url.pathname === `${ROUTE}/api/bridge/ping` && req.method === 'GET') {
        writeBridgeDiscovery(hostPort(req));
        return sendJson(res, 200, { ok: true, plugin: name, route: ROUTE });
      }
      if (url.pathname === `${ROUTE}/api/bridge/pair` && req.method === 'POST') {
        const remote = String(req.socket?.remoteAddress ?? '');
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
        if (!loopback) return sendError(res, 403, 'pairing is loopback-only');
        const host = String(req.headers.host ?? '');
        const portPart = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '80';
        return sendJson(res, 200, { ok: true, port: Number(portPart) || null, token, route: ROUTE, host });
      }
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

  ctx.effect(
    () => () => {
      for (const entry of forgeWatches.values()) {
        try {
          entry.dispose?.();
        } catch {
          /* watcher already disposed */
        }
      }
      forgeWatches.clear();
    },
    'ci-review forge watches',
  );

  log(`mounted at ${ROUTE} (workspaces: ${registryProjects().length}, configured: ${configuredProjects().length})`);
  writeBridgeDiscovery();
}
