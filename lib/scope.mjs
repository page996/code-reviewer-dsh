/**
 * Scope selection — CONTRACT §3.
 *
 * Builds the deterministic file list + exclusion ledger for one run. The gate
 * order is fixed (first hit wins):
 *   1. binary           -> excludeReason "binary"
 *   2. secretGlobs      -> "secret"
 *   3. user exclude     -> "user_exclude"
 *   4. user include     -> forces reviewable, excludeReason "user_include"
 *   5. unsupported ext  -> "unsupported_ext"
 *   6. default path skip-> "default_path"
 *   7. deleted/too_large-> "deleted" / "too_large"
 *
 * createScope() is pure with respect to the filesystem: it only reads (git,
 * stat, scan walk) and returns the scope object. The caller persists it via
 * store.createRun()/store.writeJson().
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from './config.mjs';
import {
  binaryAttributes,
  detectRepoRoot,
  fileSizesAt,
  isBinaryBuffer,
  listChangedFiles,
  mergeBase,
  upstreamBranch,
} from './git.mjs';
import { matchAnyGlob } from './rules.mjs';
import { createRunId, isRunId } from './store.mjs';

export const SCOPES = Object.freeze(['workspace', 'staged', 'range', 'commit', 'scan']);

/** Extension -> language id. Keep this list explicit: unknown extensions are surfaced. */
export const SUPPORTED_EXTS = Object.freeze({
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.inl': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sc': 'scala',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ksh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.sql': 'sql',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.properties': 'ini',
  '.xml': 'xml',
  '.xsd': 'xml',
  '.xsl': 'xml',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.dart': 'dart',
  '.lua': 'lua',
  '.r': 'r',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',
  '.fsi': 'fsharp',
  '.vb': 'vbnet',
  '.tex': 'latex',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.gradle': 'groovy',
  '.groovy': 'groovy',
  '.pl': 'perl',
  '.pm': 'perl',
  '.sol': 'solidity',
  '.zig': 'zig',
  '.nim': 'nim',
  '.jl': 'julia',
  '.asm': 'assembly',
  '.s': 'assembly',
  '.thrift': 'thrift',
  '.avsc': 'json',
});

/** Extensionless files that are worth reviewing, by basename. */
export const SPECIAL_FILES = Object.freeze({
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  jenkinsfile: 'jenkins',
  procfile: 'procfile',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.nvmrc': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
});

/** Language id for a repo-relative path, or null when the extension is unsupported. */
export function languageForPath(filePath) {
  const posix = String(filePath ?? '').replace(/\\/g, '/');
  const base = posix.slice(posix.lastIndexOf('/') + 1).toLowerCase();
  if (!base) return null;
  if (Object.prototype.hasOwnProperty.call(SPECIAL_FILES, base)) return SPECIAL_FILES[base];
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot);
  return Object.prototype.hasOwnProperty.call(SUPPORTED_EXTS, ext) ? SUPPORTED_EXTS[ext] : null;
}

function scopeConfig(config) {
  const provided = config?.scope && typeof config.scope === 'object' ? config.scope : {};
  const pickArray = (key, fallback) => (Array.isArray(provided[key]) ? provided[key] : fallback);
  const maxFileBytes = Number.isInteger(provided.maxFileBytes) && provided.maxFileBytes > 0 ? provided.maxFileBytes : DEFAULTS.scope.maxFileBytes;
  return {
    include: pickArray('include', DEFAULTS.scope.include),
    exclude: pickArray('exclude', DEFAULTS.scope.exclude),
    skipGlobs: pickArray('skipGlobs', DEFAULTS.scope.skipGlobs),
    secretGlobs: pickArray('secretGlobs', DEFAULTS.scope.secretGlobs),
    maxFileBytes,
  };
}

function usageError(message) {
  const err = new Error(message);
  err.code = 'USAGE';
  return err;
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sniffBinaryFile(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buffer = Buffer.alloc(8000);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return isBinaryBuffer(buffer.subarray(0, read));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function fileSizeOnDisk(absPath) {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

function joinPosix(base, name) {
  if (!base) return name;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

/**
 * Recursively walk the scan root. Directories matching scope.skipGlobs (plus
 * `.git` and `.review`, which hold VCS metadata / generated run artifacts) are
 * pruned; individual files are returned repo-relative POSIX.
 */
function walkScan({ root, startAbs, skipGlobs }) {
  const results = [];
  let startStat;
  try {
    startStat = fs.statSync(startAbs);
  } catch {
    throw usageError(`scan path not found: ${startAbs}`);
  }
  const startRel = toPosix(path.relative(root, startAbs));
  const relativeToRoot = (abs) => toPosix(path.relative(root, abs));

  if (startStat.isFile()) {
    results.push({ path: relativeToRoot(startAbs), abs: startAbs });
    return results;
  }
  if (!startStat.isDirectory()) return results;

  const alwaysSkip = new Set(['.git', '.hg', '.svn', '.review']);
  const stack = [{ abs: startAbs, rel: startRel === '.' ? '' : startRel }];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));
    const childDirs = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childAbs = path.join(dir.abs, entry.name);
      const childRel = joinPosix(dir.rel, entry.name);
      if (entry.isDirectory()) {
        if (alwaysSkip.has(entry.name)) continue;
        if (matchAnyGlob(skipGlobs, `${childRel}/`)) continue;
        childDirs.push({ abs: childAbs, rel: childRel });
        continue;
      }
      if (!entry.isFile()) continue;
      results.push({ path: childRel, abs: childAbs });
    }
    // Push in reverse so names come out in ascending order.
    for (let i = childDirs.length - 1; i >= 0; i -= 1) stack.push(childDirs[i]);
  }
  results.sort((a, b) => compareStrings(a.path, b.path));
  return results;
}

function normalizePathFilter({ root, cwd, path: rawPath }) {
  if (!rawPath || rawPath === '.' || rawPath === './') return '';
  const raw = String(rawPath);
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(path.resolve(raw));
  else {
    candidates.push(path.resolve(cwd, raw));
    candidates.push(path.resolve(root, raw));
  }
  for (const abs of candidates) {
    const rel = toPosix(path.relative(root, abs));
    if (rel === '') return '';
    if (!rel.startsWith('..') && rel !== '..' && !path.isAbsolute(rel)) return rel.replace(/\/+$/, '');
  }
  throw usageError(`--path must point inside the repository: ${rawPath}`);
}

function scanEntries({ root, scopePath, skipGlobs }) {
  const startAbs = scopePath ? path.resolve(root, scopePath) : root;
  const walked = walkScan({ root, startAbs, skipGlobs });
  const binaryFlagged = binaryAttributes(root, walked.map((item) => item.path));
  return walked.map((item) => {
    const bytes = fileSizeOnDisk(item.abs);
    return {
      path: item.path,
      status: 'existing',
      insertions: 0,
      deletions: 0,
      binary: sniffBinaryFile(item.abs) || binaryFlagged.has(item.path),
      oldPath: null,
      bytes: bytes >= 0 ? bytes : 0,
    };
  });
}

function bytesForChangedFiles({ root, mode, entries, head, commit }) {
  const sizes = new Map();
  const needsDisk = mode === 'workspace' || mode === 'staged';
  if (needsDisk) {
    for (const entry of entries) {
      const abs = path.resolve(root, ...entry.path.split('/'));
      sizes.set(entry.path, entry.status === 'deleted' ? 0 : Math.max(0, fileSizeOnDisk(abs)));
    }
    return sizes;
  }
  const ref = mode === 'commit' ? commit : head || 'HEAD';
  const wanted = entries.filter((entry) => entry.status !== 'deleted').map((entry) => entry.path);
  let atRef = new Map();
  try {
    atRef = fileSizesAt({ cwd: root, ref, paths: wanted });
  } catch {
    atRef = new Map();
  }
  for (const entry of entries) {
    if (entry.status === 'deleted') {
      sizes.set(entry.path, 0);
      continue;
    }
    const size = atRef.get(entry.path);
    sizes.set(entry.path, typeof size === 'number' && size >= 0 ? size : 0);
  }
  return sizes;
}

function classifyEntry(entry, { cfg, mode }) {
  const bytes = entry.bytes ?? 0;
  const base = {
    path: entry.path,
    status: entry.status,
    insertions: entry.insertions ?? 0,
    deletions: entry.deletions ?? 0,
    binary: Boolean(entry.binary),
    language: languageForPath(entry.path),
    bytes,
    oldPath: entry.oldPath ?? null,
  };

  let excludeReason = null;
  let reviewable = false;
  if (entry.binary) {
    excludeReason = 'binary';
  } else if (matchAnyGlob(cfg.secretGlobs, entry.path)) {
    excludeReason = 'secret';
  } else if (matchAnyGlob(cfg.exclude, entry.path)) {
    excludeReason = 'user_exclude';
  } else if (matchAnyGlob(cfg.include, entry.path)) {
    // Forced inclusion: user explicitly asked for this file.
    excludeReason = 'user_include';
    reviewable = true;
  } else if (!base.language) {
    excludeReason = 'unsupported_ext';
  } else if (matchAnyGlob(cfg.skipGlobs, entry.path)) {
    excludeReason = 'default_path';
  } else if (entry.status === 'deleted') {
    excludeReason = 'deleted';
  } else if (bytes > cfg.maxFileBytes) {
    excludeReason = 'too_large';
  } else {
    reviewable = true;
  }

  return {
    ...base,
    reviewable,
    excludeReason,
  };
}

function runIdFor(runId) {
  if (runId === undefined || runId === null || runId === '') return createRunId();
  if (typeof runId !== 'string' || !isRunId(runId.trim())) {
    throw usageError(`invalid runId (expected run-YYYYMMDD-HHmmss-<4hex>): ${String(runId)}`);
  }
  return runId.trim();
}

/**
 * Build the scope object for a run.
 * @param {{cwd?: string, config?: object, mode?: string, base?: string, head?: string,
 *          commit?: string, path?: string, runId?: string, log?: Function}} [options]
 * @returns {object} scope.json shaped object (nothing is written)
 */
export function createScope({ cwd, config, mode, base, head, commit, path: scopePathRaw, runId, log } = {}) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const resolvedMode = mode || 'workspace';
  if (!SCOPES.includes(resolvedMode)) throw usageError(`invalid mode: ${resolvedMode} (expected ${SCOPES.join('|')})`);
  const cfg = scopeConfig(config);
  const id = runIdFor(runId);

  let root;
  let inGitRepo = true;
  if (resolvedMode === 'scan') {
    try {
      root = detectRepoRoot(resolvedCwd);
    } catch {
      inGitRepo = false;
      root = resolvedCwd;
    }
  } else {
    try {
      root = detectRepoRoot(resolvedCwd);
    } catch {
      throw usageError(`not a git repository: ${resolvedCwd}`);
    }
  }

  const range = { base: null, head: null, mergeBase: null, commit: null };
  let rawEntries;
  let skipPathFilter = false;

  if (resolvedMode === 'scan') {
    const filterRel = normalizePathFilter({ root, cwd: resolvedCwd, path: scopePathRaw });
    rawEntries = scanEntries({ root, scopePath: filterRel, skipGlobs: cfg.skipGlobs });
  } else {
    if (resolvedMode === 'commit' && !commit) throw usageError('commit mode requires --commit C');
    if (resolvedMode === 'range') {
      const baseRef = base || upstreamBranch(resolvedCwd) || 'main';
      const headRef = head || 'HEAD';
      if (!base) log?.('debug', `range base not given, using ${baseRef}`);
      const mb = mergeBase(resolvedCwd, baseRef, headRef);
      range.base = baseRef;
      range.head = headRef;
      range.mergeBase = mb;
    } else if (resolvedMode === 'commit') {
      range.commit = commit;
      range.head = commit;
    }
    rawEntries = listChangedFiles({ cwd: resolvedCwd, mode: resolvedMode, base: range.base || undefined, head: range.head || undefined, commit });
    if (scopePathRaw && scopePathRaw !== '.' && scopePathRaw !== './') {
      const filterRel = normalizePathFilter({ root, cwd: resolvedCwd, path: scopePathRaw });
      rawEntries = rawEntries.filter((entry) => entry.path === filterRel || entry.path.startsWith(`${filterRel}/`));
      skipPathFilter = true;
    }
  }
  void skipPathFilter;

  const sizes = bytesForChangedFiles({
    root,
    mode: resolvedMode,
    entries: rawEntries,
    base: range.base,
    head: range.head,
    commit,
  });
  const withBytes = rawEntries.map((entry) => ({
    ...entry,
    bytes: sizes.has(entry.path) ? sizes.get(entry.path) : entry.bytes ?? 0,
  }));

  const files = withBytes.map((entry) => classifyEntry(entry, { cfg, mode: resolvedMode }));
  files.sort((a, b) => compareStrings(a.path, b.path));

  const reviewable = files.filter((file) => file.reviewable);
  const unreviewed = files
    .filter((file) => !file.reviewable && (file.excludeReason === 'unsupported_ext' || file.excludeReason === 'too_large'))
    .map((file) => file.path);
  const counts = {
    total: files.length,
    reviewable: reviewable.length,
    excluded: files.length - reviewable.length,
    insertions: files.reduce((sum, file) => sum + (file.insertions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
  };

  const scope = {
    schemaVersion: 1,
    runId: id,
    repo: { root, name: path.basename(root) },
    mode: resolvedMode,
    range,
    files,
    counts,
    coverage: { complete: unreviewed.length === 0, unreviewed },
  };
  log?.('debug', 'scope built', { mode: resolvedMode, total: counts.total, reviewable: counts.reviewable, git: inGitRepo });
  return scope;
}
