/**
 * Git plumbing — CONTRACT §3.
 *
 * All git invocations use spawnSync with an argv array (shell: false), with
 * `--no-pager`, `core.quotepath=false` and no color, so paths and output are
 * deterministic and Windows-safe. Repository-relative paths are always exposed
 * in POSIX form (`server/a.ts`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const EMPTY_TREE_CACHE = new Map();

/** Build an Error with contract code GIT. */
export function gitError(message, result) {
  const err = new Error(message);
  err.code = 'GIT';
  if (result) {
    err.status = result.status;
    err.stderr = String(result.stderr ?? '').trim();
  }
  return err;
}

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function toPosixOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return toPosix(value);
}

function fromPosix(value) {
  return String(value).split('/').join(path.sep);
}

function assertOk(result, what) {
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw gitError(`${what} failed (git exit ${result.status})${detail ? `: ${detail}` : ''}`, result);
  }
  return result;
}

/**
 * Run git and capture output. Never throws for a non-zero git status — callers
 * decide. Spawn failures (git missing, etc.) throw an Error with code GIT.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{input?: string|Buffer, timeoutMs?: number, maxBuffer?: number, env?: object}} [options]
 */
export function runGit(cwd, args, options = {}) {
  if (!Array.isArray(args)) throw gitError('runGit requires an args array');
  const dir = cwd ? path.resolve(cwd) : process.cwd();
  const fullArgs = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
  const result = spawnSync('git', fullArgs, {
    cwd: dir,
    shell: false,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    windowsHide: true,
    // Keep the ambient environment (git needs PATH/HOME); only stop optional
    // index-refresh writes so read-only plumbing never mutates the repo.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(options.env ?? {}) },
  });
  if (result.error) {
    throw gitError(`failed to run git ${args[0] ?? ''}: ${result.error.message}`, {
      status: -1,
      stderr: '',
    });
  }
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal ?? null,
  };
}

/** Absolute repository root, or throw code GIT. */
export function detectRepoRoot(cwd) {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) {
    throw gitError(`not inside a git repository: ${cwd ? path.resolve(cwd) : process.cwd()}`, result);
  }
  const top = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!top) throw gitError(`git rev-parse --show-toplevel returned no path`, result);
  return path.resolve(top);
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd) {
  try {
    detectRepoRoot(cwd);
    return true;
  } catch {
    return false;
  }
}

const REPO_ROOT_CACHE = new Map();
function cachedRepoRoot(cwd) {
  const dir = path.resolve(cwd || process.cwd());
  if (REPO_ROOT_CACHE.has(dir)) return REPO_ROOT_CACHE.get(dir);
  let root = null;
  try {
    root = detectRepoRoot(dir);
  } catch {
    root = null;
  }
  REPO_ROOT_CACHE.set(dir, root);
  return root;
}

/** Current branch name (`HEAD` when detached, '' when there are no commits/branch). */
export function currentBranch(cwd) {
  const dir = typeof cwd === 'object' && cwd !== null ? cwd.cwd : cwd;
  const symbolic = runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (symbolic.status === 0) {
    const name = symbolic.stdout.trim();
    if (name) return name;
  }
  const rev = runGit(dir, ['rev-parse', '--short', 'HEAD']);
  if (rev.status === 0) return 'HEAD';
  return '';
}

/** Resolve an upstream ref such as `origin/main`, or null. */
export function upstreamBranch(cwd) {
  const dir = typeof cwd === 'object' && cwd !== null ? cwd.cwd : cwd;
  const result = runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (result.status !== 0) return null;
  const name = result.stdout.trim();
  return name || null;
}

/** Resolve a ref to a full object id, or null. */
export function revParse(cwd, ref) {
  if (!ref) return null;
  const result = runGit(cwd, ['rev-parse', '--verify', '--quiet', String(ref)]);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

/** `git merge-base a b` -> sha, or null when the histories are unrelated. */
export function mergeBase(first, second, third) {
  let cwd;
  let a;
  let b;
  if (typeof first === 'object' && first !== null) {
    cwd = first.cwd;
    a = first.base ?? first.a;
    b = first.head ?? first.b;
  } else {
    cwd = first;
    a = second;
    b = third;
  }
  if (!a || !b) return null;
  const result = runGit(cwd, ['merge-base', String(a), String(b)]);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

function hasHead(cwd) {
  return runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0;
}

/** Hash of the empty tree for this repository (works for sha1 and sha256 repos). */
export function emptyTreeHash(cwd) {
  let root;
  try {
    root = detectRepoRoot(cwd);
  } catch {
    root = path.resolve(cwd || process.cwd());
  }
  const cached = EMPTY_TREE_CACHE.get(root);
  if (cached) return cached;
  const result = runGit(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw gitError('cannot compute the empty tree hash', result);
  }
  const hash = result.stdout.trim();
  EMPTY_TREE_CACHE.set(root, hash);
  return hash;
}

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

function countLinesInText(text) {
  if (!text) return 0;
  const parts = String(text).split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Number of lines in a text blob (a trailing newline does not add a line). */
export function countLines(text) {
  return countLinesInText(text);
}

/** NUL-byte heuristic used for untracked/scan content. */
export function isBinaryBuffer(buffer) {
  if (!buffer) return false;
  const slice = Buffer.isBuffer(buffer) ? buffer.subarray(0, BINARY_SNIFF_BYTES) : Buffer.from(buffer).subarray(0, BINARY_SNIFF_BYTES);
  for (let i = 0; i < slice.length; i += 1) {
    if (slice[i] === 0) return true;
  }
  return false;
}

/**
 * Parse `git diff --name-status -z` output.
 * @returns {Array<{status: string, path: string, oldPath: string|null}>}
 */
export function parseNameStatusZ(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const letter = token[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (!newPath) continue;
      entries.push({ status: letter === 'R' ? 'renamed' : 'added', path: toPosix(newPath), oldPath: toPosixOrNull(oldPath) });
      continue;
    }
    const filePath = tokens[i + 1] ?? '';
    i += 1;
    if (!filePath) continue;
    let status;
    switch (letter) {
      case 'A':
        status = 'added';
        break;
      case 'D':
        status = 'deleted';
        break;
      case 'R':
        status = 'renamed';
        break;
      default:
        status = 'modified';
    }
    entries.push({ status, path: toPosix(filePath), oldPath: null });
  }
  return entries;
}

/**
 * Parse `git diff --numstat -z` output (rename entries encode old/new paths).
 * @returns {Array<{path: string, oldPath: string|null, insertions: number, deletions: number, binary: boolean}>}
 */
export function parseNumstatZ(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const fields = token.split('\t');
    if (fields.length < 3) continue;
    const binary = fields[0] === '-' || fields[1] === '-';
    const insertions = binary ? 0 : Number.parseInt(fields[0], 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(fields[1], 10) || 0;
    let filePath = fields.slice(2).join('\t');
    let oldPath = null;
    if (filePath === '') {
      oldPath = tokens[i + 1] ?? '';
      filePath = tokens[i + 2] ?? '';
      i += 2;
    }
    if (!filePath) continue;
    entries.push({
      path: toPosix(filePath),
      oldPath: oldPath ? toPosix(oldPath) : null,
      insertions,
      deletions,
      binary,
    });
  }
  return entries;
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 * @returns {Array<{path: string, status: string, oldPath: string|null}>}
 */
export function parseStatusZ(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const xy = token.slice(0, 2);
    let filePath = token.slice(3);
    let oldPath = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      oldPath = tokens[i + 1] ?? '';
      i += 1;
    }
    if (!filePath) continue;
    let status;
    if (xy === '??' || xy === '!!') status = 'untracked';
    else if (xy[0] === 'D' || xy[1] === 'D') status = 'deleted';
    else if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') status = 'renamed';
    else if (xy[0] === 'A' || xy[1] === 'A') status = 'added';
    else status = 'modified';
    entries.push({ path: toPosix(filePath), status, oldPath: toPosixOrNull(oldPath) });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// diff enumeration
// ---------------------------------------------------------------------------

function runDiff(cwd, args) {
  const result = runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', ...args]);
  assertOk(result, 'git diff');
  return result.stdout;
}

function diffEntries(cwd, { from, to, cached = false }) {
  const scopeArgs = ['--name-status', '-z', '-M'];
  const numstatArgs = ['--numstat', '-z', '-M'];
  if (cached) {
    scopeArgs.push('--cached');
    numstatArgs.push('--cached');
  }
  const range = [];
  if (from) range.push(String(from));
  if (to) range.push(String(to));

  const statusOut = runDiff(cwd, [...scopeArgs, ...range, '--']);
  const numstatOut = runDiff(cwd, [...numstatArgs, ...range, '--']);
  const statusEntries = parseNameStatusZ(statusOut);
  const stats = parseNumstatZ(numstatOut);
  const statByPath = new Map();
  for (const stat of stats) statByPath.set(stat.path, stat);

  const merged = [];
  for (const entry of statusEntries) {
    let stat = statByPath.get(entry.path);
    if (!stat && entry.oldPath) {
      stat = stats.find((candidate) => candidate.oldPath === entry.oldPath) ?? null;
    }
    merged.push({
      path: entry.path,
      status: entry.status,
      insertions: stat?.insertions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: Boolean(stat?.binary),
      oldPath: entry.oldPath ?? stat?.oldPath ?? null,
    });
  }
  merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return merged;
}

/** Files changed in workspace mode (staged + unstaged + untracked). */
function workspaceEntries(cwd) {
  const statusResult = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assertOk(statusResult, 'git status');
  const statusEntries = parseStatusZ(statusResult.stdout);
  const from = hasHead(cwd) ? 'HEAD' : emptyTreeHash(cwd);
  const diffed = diffEntries(cwd, { from });
  const diffByPath = new Map(diffed.map((entry) => [entry.path, entry]));

  const out = [];
  const seen = new Set();
  for (const entry of statusEntries) {
    seen.add(entry.path);
    if (entry.status === 'untracked') {
      const abs = resolveFilePath(cwd, entry.path);
      let insertions = 0;
      let binary = false;
      try {
        const buffer = fs.readFileSync(abs);
        binary = isBinaryBuffer(buffer);
        if (!binary) insertions = countLinesInText(buffer.toString('utf8'));
      } catch {
        insertions = 0;
      }
      out.push({ path: entry.path, status: 'untracked', insertions, deletions: 0, binary, oldPath: null });
      continue;
    }
    const diff = diffByPath.get(entry.path) ?? (entry.oldPath ? diffByPath.get(entry.oldPath) : undefined);
    out.push({
      path: entry.path,
      status: entry.status,
      insertions: diff?.insertions ?? 0,
      deletions: diff?.deletions ?? 0,
      binary: Boolean(diff?.binary),
      oldPath: entry.oldPath,
    });
  }
  for (const diff of diffed) {
    if (seen.has(diff.path)) continue;
    out.push(diff);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function resolveFilePath(cwd, input) {
  const candidates = [];
  if (path.isAbsolute(String(input))) candidates.push(String(input));
  else {
    const root = cachedRepoRoot(cwd);
    if (root) candidates.push(path.join(root, fromPosix(input)));
    candidates.push(path.resolve(cwd || process.cwd(), String(input)));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * List changed files for one of the CONTRACT §3 modes.
 * @param {{cwd: string, mode: 'workspace'|'staged'|'range'|'commit', base?: string,
 *          head?: string, commit?: string}} options
 * @returns {Array<{path: string, status: string, insertions: number, deletions: number,
 *                  binary: boolean, oldPath: string|null}>}
 */
export function listChangedFiles({ cwd, mode = 'workspace', base, head, commit } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  if (mode === 'workspace') return workspaceEntries(dir);
  if (mode === 'staged') {
    const from = hasHead(dir) ? 'HEAD' : emptyTreeHash(dir);
    return diffEntries(dir, { from, cached: true });
  }
  if (mode === 'range') {
    const baseRef = base || 'main';
    const headRef = head || 'HEAD';
    const from = mergeBase(dir, baseRef, headRef) || baseRef;
    return diffEntries(dir, { from, to: headRef });
  }
  if (mode === 'commit') {
    if (!commit) throw gitError('commit mode requires a commit hash');
    const parent = revParse(dir, `${commit}^`);
    const from = parent || emptyTreeHash(dir);
    return diffEntries(dir, { from, to: commit });
  }
  const err = new Error(`unsupported changed-files mode: ${mode}`);
  err.code = 'USAGE';
  throw err;
}

/** Resolve `{base, head, mergeBase}` for range/commit comparison. */
export function resolveRange({ cwd, base, head, commit } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  if (commit) {
    const parent = revParse(dir, `${commit}^`);
    return { base: parent || null, head: commit, mergeBase: parent || null, commit };
  }
  const baseRef = base || 'main';
  const headRef = head || 'HEAD';
  const mb = mergeBase(dir, baseRef, headRef);
  return { base: baseRef, head: headRef, mergeBase: mb, commit: null };
}

/**
 * Binary attributes from git (`binary` set or `-diff`), for paths where a diff
 * heuristic is unavailable (untracked/scan). Returns a Set of POSIX paths.
 */
export function binaryAttributes(cwd, paths = []) {
  const relPaths = paths.map((p) => toPosix(p)).filter(Boolean);
  const flagged = new Set();
  const chunkSize = 100;
  for (let start = 0; start < relPaths.length; start += chunkSize) {
    const chunk = relPaths.slice(start, start + chunkSize);
    const result = runGit(cwd, ['check-attr', '-z', 'binary', 'diff', '--', ...chunk]);
    if (result.status !== 0) continue;
    const tokens = String(result.stdout ?? '').split('\0');
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      const filePath = tokens[i];
      const attr = tokens[i + 1];
      const value = tokens[i + 2];
      if (!filePath) continue;
      if ((attr === 'binary' && value === 'set') || (attr === 'diff' && value === 'unset')) {
        flagged.add(toPosix(filePath));
      }
    }
  }
  return flagged;
}

function synthesizeAddPatch({ cwd, filePath, content }) {
  const rel = toPosix(filePath);
  const text = content === null || content === undefined ? '' : String(content);
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const header = [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`];
  if (lines.length === 0) return `${header.join('\n')}\n`;
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  return `${[...header, ...hunk].join('\n')}\n`;
}

/**
 * Unified diff text for one file. Untracked/scan files get a synthesized
 * "new file" patch from their current content.
 * @param {{cwd: string, path: string, mode: string, base?: string, head?: string,
 *          commit?: string, oldPath?: string|null, status?: string}} options
 * @returns {string}
 */
export function filePatch({ cwd, path: filePath, mode = 'workspace', base, head, commit, oldPath, status } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const rel = toPosix(filePath).replace(/^\.\//, '');
  if (!rel) throw gitError('filePatch requires a path');
  const content = fileContentNow({ cwd: dir, path: rel });
  const synthesize = () => {
    if (content === null) return '';
    if (isBinaryBuffer(Buffer.from(content, 'utf8'))) return '';
    return synthesizeAddPatch({ cwd: dir, filePath: rel, content });
  };

  if (mode === 'scan') return synthesize();

  const explicitlyUntracked = status === 'untracked' || status === 'existing';
  if (explicitlyUntracked) return synthesize();

  if (mode === 'workspace' && status === undefined) {
    const statusResult = runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel]);
    if (statusResult.status === 0 && parseStatusZ(statusResult.stdout).some((entry) => entry.status === 'untracked')) {
      return synthesize();
    }
  }

  const pathspecs = [rel];
  if (oldPath && toPosix(oldPath) !== rel) pathspecs.push(toPosix(oldPath));
  let range;
  let cached = false;
  if (mode === 'staged') {
    range = hasHead(dir) ? ['HEAD'] : [emptyTreeHash(dir)];
    cached = true;
  } else if (mode === 'workspace') {
    range = hasHead(dir) ? ['HEAD'] : [emptyTreeHash(dir)];
  } else if (mode === 'range') {
    const from = mergeBase(dir, base || 'main', head || 'HEAD') || base || 'main';
    range = [from, head || 'HEAD'];
  } else if (mode === 'commit') {
    if (!commit) throw gitError('commit mode requires a commit hash');
    const parent = revParse(dir, `${commit}^`);
    range = [parent || emptyTreeHash(dir), commit];
  } else {
    const err = new Error(`unsupported filePatch mode: ${mode}`);
    err.code = 'USAGE';
    throw err;
  }

  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (cached) args.push('--cached');
  args.push(...range, '--', ...pathspecs);
  const result = runGit(dir, args);
  assertOk(result, `git diff for ${rel}`);
  const patch = result.stdout;
  if (!patch.trim() && content !== null && (mode === 'scan' || explicitlyUntracked)) return synthesize();
  return patch;
}

/**
 * Parse a unified patch. Returns line numbers in the NEW file that are added or
 * context, plus the raw hunks.
 * @param {string} patch
 * @returns {{newLines: Set<number>, hunks: Array<{header: string, lines: string[]}>}}
 */
export function parsePatchNewLines(patch) {
  const newLines = new Set();
  const hunks = [];
  const text = String(patch ?? '');
  if (!text) return { newLines, hunks };
  let current = null;
  let newLine = 0;
  for (const line of text.split(/\r?\n/)) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      current = { header: line, lines: [] };
      hunks.push(current);
      newLine = Number.parseInt(hunkMatch[2], 10);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+')) {
      newLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      // removed line: does not advance the new-file counter
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else if (line.startsWith(' ')) {
      newLines.add(newLine);
      newLine += 1;
    }
  }
  return { newLines, hunks };
}

/**
 * File content at a git ref (text). Returns null when the path does not exist at
 * that ref.
 */
export function fileContentAt({ cwd, path: filePath, ref } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const root = detectRepoRoot(dir);
  const rel = repoRelative(root, filePath);
  const objectRef = `${ref || 'HEAD'}:${rel}`;
  const result = runGit(dir, ['cat-file', 'blob', objectRef]);
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Current file content (text). Returns null when the file does not exist. */
export function fileContentNow({ cwd, path: filePath } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const abs = resolveFilePath(dir, filePath);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function repoRelative(root, filePath) {
  if (path.isAbsolute(String(filePath))) {
    const rel = path.relative(root, String(filePath));
    return toPosix(rel || '.');
  }
  return toPosix(String(filePath)).replace(/^\.\//, '');
}

/**
 * Sizes (bytes) of many paths at one ref, using a single `git cat-file
 * --batch-check` call. Missing paths map to -1.
 * @returns {Map<string, number>}
 */
export function fileSizesAt({ cwd, ref, paths = [] } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const root = detectRepoRoot(dir);
  const relPaths = paths.map((p) => repoRelative(root, p));
  const sizes = new Map();
  if (relPaths.length === 0) return sizes;
  const input = relPaths.map((rel) => `${ref || 'HEAD'}:${rel}`).join('\n');
  const result = runGit(dir, ['cat-file', '--batch-check=%(objectsize)'], { input: `${input}\n` });
  if (result.status !== 0) {
    for (const rel of relPaths) sizes.set(rel, -1);
    return sizes;
  }
  const lines = String(result.stdout ?? '').split(/\r?\n/);
  for (let i = 0; i < relPaths.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (/^\d+$/.test(line)) sizes.set(relPaths[i], Number.parseInt(line, 10));
    else sizes.set(relPaths[i], -1);
  }
  return sizes;
}

/** Size in bytes of the current on-disk file, or -1. */
export function fileSizeNow({ cwd, path: filePath } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const abs = resolveFilePath(dir, filePath);
  try {
    return fs.statSync(abs).size;
  } catch {
    return -1;
  }
}
