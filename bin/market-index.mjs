#!/usr/bin/env node
/**
 * bin/market-index.mjs — regenerate `market/index.json`, the plugin market
 * index users add in DSH (Discover / plugin settings) to install and update
 * this repository's DSH bundles directly.
 *
 * Format: plugin market index format 1 (validated by
 * `@deepseek-ai/dsh-plugin-market-index` on every DSH read). Each entry pins a
 * commit of this repository, so a market copy updates through DSH's built-in
 * `update-available` flow — no custom update checker inside the plugin.
 *
 * Release SOP (持久化运营):
 *   1. bump the plugin versions in each `plugins/<name>/package.json` and commit the
 *      release (tests green);
 *   2. run `node bin/market-index.mjs` — it pins THAT commit (or pass
 *      `--commit <sha>`) and rewrites `market/index.json`;
 *   3. commit the index change and push. Users' Discover page then shows
 *      "update available" and updates with one click (git-installed copies
 *      update in place; local-directory copies are reinstalled from the index).
 *
 * Usage:
 *   node bin/market-index.mjs [--commit <sha>] [--out market/index.json]
 *   node bin/market-index.mjs --check   # validate the written index only
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/page996/code-reviewer-dsh';
const RAW_BASE = REPO_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/');
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;

/** SemVer precedence compare (build metadata ignored); >0 when a > b. */
function compareSemver(a, b) {
  const parse = (value) => {
    // Strip build metadata, then split at the FIRST hyphen so prerelease
    // identifiers may themselves contain hyphens (1.0.0-rc-2).
    const text = String(value).replace(/\+.*$/, '');
    const hyphen = text.indexOf('-');
    const core = hyphen >= 0 ? text.slice(0, hyphen) : text;
    const pre = hyphen >= 0 ? text.slice(hyphen + 1) : null;
    return { nums: core.split('.').map(Number), pre: pre === null ? null : pre.split('.') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i];
  }
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  // SemVer 2.0.0 §11: per-identifier compare; numeric < alphanumeric; a longer
  // prerelease wins when every shared identifier compares equal.
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i += 1) {
    const partA = left.pre[i];
    const partB = right.pre[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const numA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numB = /^\d+$/.test(partB) ? Number(partB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
    } else if (numA !== null) {
      return -1;
    } else if (numB !== null) {
      return 1;
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
  }
  return 0;
}

const args = process.argv.slice(2);
/** Accept both `--name value` and `--name=value`; reject a bare flag with no value. */
function flagValue(name) {
  const equals = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(equals)) return arg.slice(equals.length);
  }
  const at = args.indexOf(name);
  if (at >= 0) {
    if (at + 1 >= args.length || args[at + 1].startsWith('--')) return null;
    return args[at + 1];
  }
  return undefined;
}
const CHECK_ONLY = args.includes('--check');

function fail(message) {
  console.error(`[market-index] ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readPackage(relativeDir) {
  const file = path.join(ROOT, relativeDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.name || !SEMVER.test(String(pkg.version))) fail(`${relativeDir}/package.json has no valid name/version`);
  return { dir: relativeDir, name: pkg.name, version: String(pkg.version), description: String(pkg.description ?? '') };
}

/** Structural self-check mirroring the format-1 validator rules we rely on. */
function validateIndex(index) {
  // Guard malformed input (null, non-object, missing plugins) so --check fails
  // through the clean fail() path instead of an uncaught TypeError.
  if (!index || typeof index !== 'object' || !Array.isArray(index.plugins)) fail('index must be an object with a plugins array');
  for (const [position, plugin] of index.plugins.entries()) {
    if (!plugin || typeof plugin !== 'object') fail(`$.plugins[${position}] must be an object`);
  }
  if (index.format !== 1) fail('$.format must be 1');
  if (!index.title || !index.title.en || !String(index.title.en).trim()) fail('$.title.en required');
  const names = new Set();
  for (const [position, plugin] of index.plugins.entries()) {
    const at = `$.plugins[${position}]`;
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(plugin.name)) fail(`${at}.name invalid: ${plugin.name}`);
    if (names.has(plugin.name)) fail(`${at}.name duplicates ${plugin.name}`);
    names.add(plugin.name);
    if (!plugin.title?.en) fail(`${at}.title.en required`);
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail(`${at}.versions must be non-empty`);
    const seen = new Set();
    for (const [indexAt, version] of plugin.versions.entries()) {
      const vat = `${at}.versions[${indexAt}]`;
      if (!SEMVER.test(version.version)) fail(`${vat}.version must be exact semver`);
      if (seen.has(version.version)) fail(`${vat}.version duplicates ${version.version}`);
      seen.add(version.version);
      if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0 || version.publishTimestamp >= 1e11) fail(`${vat}.publishTimestamp invalid`);
      const source = version.source;
      if (source.type === 'npm') {
        if (source.registry !== undefined && !/^https?:\/\/[^?#]+$/.test(source.registry)) fail(`${vat}.source.registry invalid`);
      } else if (source.type === 'git') {
        if (!/^https:\/\/[^?#]+$/.test(source.url) || !/^(\/[^/]+){2,}$/.test(new URL(source.url).pathname)) fail(`${vat}.source.url must be a canonical https repository URL`);
        if (!COMMIT_RE.test(source.commit)) fail(`${vat}.source.commit must be 40 lowercase hex`);
        if (source.path !== undefined && String(source.path).split('/').some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._@+-]+$/.test(segment))) fail(`${vat}.source.path invalid`);
      } else {
        fail(`${vat}.source.type must be "npm" or "git"`);
      }
      if (version.icon !== undefined && !/^(https:\/\/|data:image\/)/.test(String(version.icon))) fail(`${vat}.icon must be https or a data URL`);
      if (version.repository !== undefined) {
        if (!/^https?:\/\/[^?#]+$/.test(version.repository.url)) fail(`${vat}.repository.url invalid`);
      }
    }
    // buildIndex emits repository/icon/homepage at the plugin level; check the
    // same https rules there (new URL throws on garbage — guard it).
    if (plugin.icon !== undefined && !/^(https:\/\/|data:image\/)/.test(String(plugin.icon))) fail(`${at}.icon must be https or a data URL`);
    if (plugin.homepage !== undefined && !/^https?:\/\/[^?#]+$/.test(String(plugin.homepage))) fail(`${at}.homepage must be an http(s) URL`);
    if (plugin.repository !== undefined) {
      if (!/^https?:\/\/[^?#]+$/.test(String(plugin.repository?.url ?? ''))) fail(`${at}.repository.url invalid`);
      if (plugin.repository?.directory !== undefined && !/^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(String(plugin.repository.directory))) fail(`${at}.repository.directory invalid`);
    }
    for (const id of plugin.metadata?.labels ?? []) {
      if (!index.metadata?.labels?.[id]) fail(`${at} references undeclared label ${id}`);
    }
    if (plugin.metadata?.category && !index.metadata?.categories?.[plugin.metadata.category]) {
      fail(`${at} references undeclared category ${plugin.metadata.category}`);
    }
  }
}

function buildIndex(commit, previous) {
  const plugins = [
    {
      package: readPackage('plugins/ci-review'),
      title: { en: 'CI review workbench', zh: 'CI 评审工作台' },
      description: {
        en: 'One DSH panel for code review and CI: PR/checks/Actions state, local review runs and sessions, review cards with multi-verifier voting, background fix agents, and a VS Code bridge.',
        zh: '一个 DSH 面板看清代码评审与 CI：PR/检查/Actions 状态、本地评审运行与会话、按问题分批的审阅卡与多验证者投票、后台修复 Agent、VS Code 桥接。',
      },
      category: 'dev-tools',
      keywords: ['code-review', 'ci', 'github', 'review-cards', 'workbench'],
      labels: ['agent-verified'],
    },
    {
      package: readPackage('plugins/dsh'),
      title: { en: 'DSH code review tools', zh: 'DSH 代码评审工具' },
      description: {
        en: 'Model-facing review tools inside DSH: review_scope / review_plan / review_run / review_gate / review_report / review_ledger plus the /review command — deterministic scope, multi-lens model review, aggregation and a reproducible gate.',
        zh: 'DSH 内的模型评审工具：review_scope / review_plan / review_run / review_gate / review_report / review_ledger 与 /review 命令——确定性选型、多视角模型评审、聚合与可复现门禁。',
      },
      category: 'dev-tools',
      keywords: ['code-review', 'review', 'gate', 'sarif'],
      labels: ['agent-verified'],
    },
  ];

  const publishTimestamp = Math.floor(Date.now() / 1000);
  const index = {
    format: 1,
    title: { en: 'DSH code-reviewer plugin index', zh: 'DSH code-reviewer 插件索引' },
    description: {
      en: 'Installable DSH bundles from the code-reviewer-dsh repository: the CI review workbench panel and the review tools plugin.',
      zh: 'code-reviewer-dsh 仓库的可安装 DSH bundle：CI 评审工作台面板与评审工具插件。',
    },
    metadata: {
      categories: {
        'dev-tools': { title: { en: 'Developer tools', zh: '开发者工具' } },
      },
      labels: {
        'agent-verified': { title: { en: 'Verified by agent review', zh: '经 Agent 评审验证' } },
      },
      sortKeys: {},
    },
    plugins: plugins.map((entry) => {
      const name = entry.package.name;
      const previousVersions = (previous?.plugins ?? []).find((plugin) => plugin.name === name)?.versions ?? [];
      const known = previousVersions.find((version) => version.version === entry.package.version);
      const source = {
        type: 'git',
        url: REPO_URL,
        commit,
        path: entry.package.dir,
      };
      const version = {
        version: entry.package.version,
        // Keep the original publish time when this exact version was already
        // published at the same commit; a bump or re-pin updates the time.
        publishTimestamp: known && known.source?.commit === commit ? known.publishTimestamp : publishTimestamp,
        source,
      };
      // Carry history: prior pinned versions below the new one (newest first,
      // capped) so installed users can see and roll back to them. Every git
      // entry must point at THIS repository — a foreign URL in an old index is
      // refused loudly instead of being re-published. Non-git entries (npm) are
      // dropped on purpose: only commit-pinned versions update in place.
      const priorOthers = previousVersions
        .filter((item) => item && item.version !== entry.package.version)
        .map((item) => {
          if (item.source?.type === 'git') {
            if (item.source.url !== REPO_URL) {
              fail(`refusing to carry ${name}@${item.version}: previous index pins a foreign repository ${item.source.url}`);
            }
            if (!COMMIT_RE.test(item.source.commit ?? '')) {
              fail(`refusing to carry ${name}@${item.version}: previous index pins a malformed commit`);
            }
            return item;
          }
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => compareSemver(b.version, a.version))
        .slice(0, 5);
      return {
        name,
        title: entry.title,
        description: entry.description,
        icon: `${RAW_BASE}/${commit}/${entry.package.dir}/icon.svg`,
        author: 'page996',
        homepage: REPO_URL,
        repository: { url: REPO_URL, directory: entry.package.dir },
        metadata: { category: entry.category, keywords: entry.keywords, labels: entry.labels },
        versions: [version, ...priorOthers],
      };
    }),
  };
  return index;
}

const outInput = flagValue('--out');
if (outInput === null) fail('--out needs a value (or use --out=<path>)');
const outRelative = outInput ?? 'market/index.json';
const outFile = path.isAbsolute(outRelative) ? outRelative : path.join(ROOT, outRelative);
let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch (error) {
  if (error?.code === 'ENOENT') {
    previous = null;
  } else {
    // A corrupt or unreadable index must not silently reset the publish
    // history; refuse so the operator inspects it first.
    fail(`cannot read existing ${outRelative}: ${error?.message ?? error} (delete it on purpose if a fresh index is intended)`);
  }
}
// Parseable but structurally invalid ({}, null, wrong format) is equally not a
// valid history source.
if (previous !== null && (typeof previous !== 'object' || !Array.isArray(previous?.plugins) || previous.format !== 1)) {
  fail(`existing ${outRelative} is structurally invalid — inspect or delete it on purpose before regenerating`);
}

if (CHECK_ONLY) {
  validateIndex(previous ?? fail(`no index to check at ${outRelative}`));
  console.log(`[market-index] ${outRelative} OK (${previous.plugins.length} plugins)`);
  process.exit(0);
}

const commitInput = flagValue('--commit');
if (commitInput === null) fail('--commit needs a 40-hex sha (or use --commit=<sha>)');
const commit = commitInput ?? git(['rev-parse', 'HEAD']);
if (!COMMIT_RE.test(commit)) fail(`--commit must be a 40-hex sha, got: ${commit}`);
// The pinned commit must exist and must actually carry the versions we are
// publishing (guards against pinning a sha that predates the version bump).
try {
  git(['cat-file', '-e', `${commit}^{commit}`]);
} catch {
  fail(`commit ${commit} does not exist in this repository`);
}
for (const dir of ['plugins/ci-review', 'plugins/dsh']) {
  let pinnedVersion = '';
  try {
    pinnedVersion = String(JSON.parse(git(['show', `${commit}:${dir}/package.json`])).version || '');
  } catch {
    fail(`commit ${commit} does not contain ${dir}/package.json`);
  }
  if (SEMVER.test(pinnedVersion) && pinnedVersion !== readPackage(dir).version) {
    fail(`${dir} is ${readPackage(dir).version} in the working tree but ${pinnedVersion} at the pinned commit — commit the version bump first`);
  }
}
const dirty = (() => {
  try {
    return git(['status', '--porcelain']).length > 0;
  } catch (error) {
    // The guard must not fail open: if cleanliness cannot be proven, say so.
    console.error(`[market-index] WARNING: git status failed (${error?.message ?? error}); cannot verify a clean tree`);
    return true;
  }
})();

const index = buildIndex(commit, previous);
validateIndex(index);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
const rawUrl = `https://raw.githubusercontent.com/${REPO_URL.replace('https://github.com/', '')}/main/${outRelative.replace(/\\/g, '/')}`;
console.log(`[market-index] wrote ${outRelative} pinned to ${commit.slice(0, 12)}${dirty ? ' (WARNING: working tree is dirty — commit the release first, then re-run)' : ''}`);
console.log(`[market-index] user-facing index URL: ${rawUrl}`);
for (const plugin of index.plugins) {
  console.log(`[market-index] ${plugin.name}@${plugin.versions[0].version} ← git+${REPO_URL}.git#${commit}&path:/${plugin.versions[0].source.path}`);
}
