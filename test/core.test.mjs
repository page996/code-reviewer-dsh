/**
 * Deterministic core tests — config/dotenv/git/scope/rules/plan/store.
 * No network. Windows-safe: spawnSync with argv arrays, temp dirs under os.tmpdir().
 *
 * Run: node --test "test/core.test.mjs"
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS,
  DEFAULT_BASE_URL,
  LENSES,
  deepMerge,
  loadConfig,
} from '../lib/config.mjs';
import { parseDotEnv, readDotEnv, resolveEnv } from '../lib/dotenv.mjs';
import {
  currentBranch,
  detectRepoRoot,
  fileContentAt,
  fileContentNow,
  filePatch,
  isGitRepo,
  listChangedFiles,
  mergeBase,
  parsePatchNewLines,
  runGit,
} from '../lib/git.mjs';
import { createScope, languageForPath, SUPPORTED_EXTS } from '../lib/scope.mjs';
import { loadRules, matchGlob, parseFrontmatter, resolveRulesForFile } from '../lib/rules.mjs';
import { EFFORT_LENSES, SCAN_SKIP_LENSES, buildPlan } from '../lib/plan.mjs';
import {
  createRun,
  createRunId,
  isRunId,
  latestRun,
  listRuns,
  readJson,
  readRun,
  resolveRunDir,
  writeJson,
} from '../lib/store.mjs';

const BUILTIN_RULES_DIR = fileURLToPath(new URL('../rules/', import.meta.url));
const RUN_ID_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort cleanup on Windows */
  }
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return String(result.stdout ?? '');
}

function initRepo() {
  const dir = mkTemp('cr-core-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Core Test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
}

function entryByPath(scope, filePath) {
  return scope.files.find((file) => file.path === filePath);
}

function baseConfig(dir, overrides = {}) {
  return deepMerge(loadConfig({ cwd: dir, env: {}, home: path.join(dir, '.test-home') }), overrides);
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('config: defaults, merge order, unknown fields, enum validation, baseUrl resolution', (t) => {
  const dir = mkTemp('cr-config-');
  t.after(() => removeTemp(dir));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  writeFile(home, '.dsh-code-review.json', JSON.stringify({
    plan: { maxFilesPerUnit: 3 },
    review: { effort: 'deep' },
    customUnknownSection: { keep: true },
  }));
  const repo = path.join(dir, 'repo');
  writeFile(repo, '.review/config.json', JSON.stringify({
    model: { model: 'unit-test-model' },
    scope: { maxFileBytes: 4096 },
    review: { effort: 'quick' },
  }));

  const config = loadConfig({ cwd: repo, home, env: {} });
  assert.equal(config.schemaVersion, DEFAULTS.schemaVersion);
  assert.equal(config.review.effort, 'quick', 'repo config overrides $DSH_HOME config');
  assert.equal(config.plan.maxFilesPerUnit, 3, '$DSH_HOME config overrides defaults');
  assert.equal(config.scope.maxFileBytes, 4096);
  assert.equal(config.model.model, 'unit-test-model');
  assert.equal(config.scope.skipGlobs.length > 0, true);
  assert.deepEqual(config.customUnknownSection, { keep: true }, 'unknown fields are preserved, not fatal');
  assert.equal(config.model.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.model.apiKeyEnv, 'DEEPSEEK_API_KEY');

  const envConfig = loadConfig({ cwd: repo, home, env: { DEEPSEEK_BASE_URL: 'https://env.example.test/' } });
  assert.equal(envConfig.model.baseUrl, 'https://env.example.test/');

  const explicit = loadConfig({ cwd: repo, home, env: { DEEPSEEK_BASE_URL: 'https://env.example.test' }, overrides: { model: { baseUrl: 'https://explicit.test' } } });
  assert.equal(explicit.model.baseUrl, 'https://explicit.test');

  // arrays replace, objects merge
  const replaced = loadConfig({ cwd: repo, home, env: {}, overrides: { scope: { exclude: ['**/x.js'] }, review: { maxComments: 5 } } });
  assert.deepEqual(replaced.scope.exclude, ['**/x.js']);
  assert.equal(replaced.review.maxComments, 5);
  assert.equal(replaced.review.effort, 'quick');

  // invalid known enum -> CONFIG error
  assert.throws(
    () => loadConfig({ cwd: repo, home, env: {}, overrides: { review: { effort: 'turbo' } } }),
    (err) => err.code === 'CONFIG',
  );
  assert.throws(
    () => loadConfig({ cwd: repo, home, env: {}, overrides: { plan: { groupBy: 'nope' } } }),
    (err) => err.code === 'CONFIG',
  );
  assert.throws(
    () => loadConfig({ cwd: repo, home, env: {}, overrides: { hooks: { preCommit: 'sometimes' } } }),
    (err) => err.code === 'CONFIG',
  );
  // unknown fields never throw
  assert.doesNotThrow(() => loadConfig({ cwd: repo, home, env: {}, overrides: { somethingNew: 1, scope: { anotherNew: true } } }));
  // explicit missing config file is a CONFIG error
  assert.throws(() => loadConfig({ cwd: repo, home, env: {}, configPath: '.review/missing.json' }), (err) => err.code === 'CONFIG');

  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.equal(Object.isFrozen(DEFAULTS.review), true);
});

test('config: invalid JSON in config file -> CONFIG error', (t) => {
  const dir = mkTemp('cr-config-bad-');
  t.after(() => removeTemp(dir));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeFile(dir, '.review/config.json', '{ not json');
  assert.throws(() => loadConfig({ cwd: dir, home, env: {} }), (err) => err.code === 'CONFIG');
});

// ---------------------------------------------------------------------------
// dotenv
// ---------------------------------------------------------------------------

test('dotenv: parsing, precedence env > cwd > home', (t) => {
  const dir = mkTemp('cr-dotenv-');
  t.after(() => removeTemp(dir));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  writeFile(home, '.env', 'HOME_ONLY=home\nSHARED=home\nQUOTED="home value"\n');
  writeFile(cwd, '.env', '# repo\nexport CWD_ONLY=cwd\nSHARED=cwd\nINLINE=value # trailing\nSINGLE=\'literal $x\'\n');

  const parsed = parseDotEnv('A=1\nB="two words"\nC=\'x y\'\nexport D=4\nE=hello # comment\nF=\n# comment\nnot a pair\n');
  assert.equal(parsed.get('A'), '1');
  assert.equal(parsed.get('B'), 'two words');
  assert.equal(parsed.get('C'), 'x y');
  assert.equal(parsed.get('D'), '4');
  assert.equal(parsed.get('E'), 'hello');
  assert.equal(parsed.get('F'), '');
  assert.equal(parsed.has('not a pair'), false);

  const merged = readDotEnv([path.join(home, '.env'), path.join(cwd, '.env')]);
  assert.equal(merged.get('HOME_ONLY'), 'home');
  assert.equal(merged.get('SHARED'), 'cwd', 'later path wins');
  assert.equal(merged.get('CWD_ONLY'), 'cwd');
  assert.equal(merged.get('INLINE'), 'value');
  assert.equal(merged.get('SINGLE'), 'literal $x');

  const env = resolveEnv({ cwd, home, env: { SHARED: 'real-env', EXTRA: 'yes' } });
  assert.equal(env.SHARED, 'real-env', 'process env wins');
  assert.equal(env.HOME_ONLY, 'home');
  assert.equal(env.CWD_ONLY, 'cwd');
  assert.equal(env.EXTRA, 'yes');
  assert.equal(env.INLINE, 'value');

  // missing files are silently skipped
  assert.equal(readDotEnv([path.join(dir, 'nope.env')]).size, 0);
});

// ---------------------------------------------------------------------------
// git plumbing + 5 scope modes
// ---------------------------------------------------------------------------

test('git: repo detection, branch, merge-base, content access', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'src/a.js', 'export const a = 1;\n');
  commitAll(dir, 'init');
  const mainSha = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-b', 'feature']);
  writeFile(dir, 'src/a.js', 'export const a = 2;\n');
  commitAll(dir, 'feature change');

  assert.equal(detectRepoRoot(path.join(dir, 'src')), path.resolve(dir));
  assert.equal(isGitRepo(dir), true);
  assert.equal(isGitRepo(path.join(dir, 'src')), true);
  assert.equal(currentBranch(dir), 'feature');
  assert.equal(mergeBase(dir, 'main', 'feature'), mainSha);
  assert.equal(mergeBase({ cwd: dir, base: 'main', head: 'feature' }), mainSha, 'mergeBase accepts object form');
  assert.equal(mergeBase(dir, 'no-such-ref', 'feature'), null);

  assert.equal(fileContentAt({ cwd: dir, path: 'src/a.js', ref: 'main' }), 'export const a = 1;\n');
  assert.equal(fileContentAt({ cwd: dir, path: 'src/a.js', ref: 'HEAD' }), 'export const a = 2;\n');
  assert.equal(fileContentAt({ cwd: dir, path: 'src/nope.js', ref: 'HEAD' }), null);
  assert.equal(fileContentNow({ cwd: dir, path: 'src/a.js' }), 'export const a = 2;\n');
  assert.equal(fileContentNow({ cwd: dir, path: 'src/nope.js' }), null);

  const result = runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'true');
  assert.equal(runGit(dir, ['rev-parse', 'no-such-ref']).status !== 0, true, 'non-zero status is returned, not thrown');
});

test('git: workspace mode lists staged + unstaged + untracked with POSIX paths', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'src/a.js', 'export const a = 1;\n');
  writeFile(dir, 'old.js', 'old\n');
  commitAll(dir, 'init');

  writeFile(dir, 'src/a.js', 'export const a = 2;\n'); // unstaged modification
  writeFile(dir, 'staged.js', 'export const s = 1;\n');
  git(dir, ['add', 'staged.js']); // staged addition
  fs.unlinkSync(path.join(dir, 'old.js')); // unstaged deletion
  writeFile(dir, 'untracked.js', 'export const u = 1;\n');

  const entries = listChangedFiles({ cwd: dir, mode: 'workspace' });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('src/a.js').status, 'modified');
  assert.equal(byPath.get('staged.js').status, 'added');
  assert.equal(byPath.get('old.js').status, 'deleted');
  assert.equal(byPath.get('untracked.js').status, 'untracked');
  assert.equal(byPath.get('untracked.js').insertions, 1);
  assert.equal(byPath.get('old.js').deletions, 1);
  for (const entry of entries) {
    assert.equal(entry.path.includes('\\'), false, 'paths are POSIX');
    assert.equal(typeof entry.insertions, 'number');
    assert.equal(typeof entry.deletions, 'number');
    assert.equal(typeof entry.binary, 'boolean');
  }
});

test('git: staged / range (merge-base) / commit modes', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'src/a.js', 'export const a = 1;\n');
  writeFile(dir, 'src/c.js', 'export const c = 1;\n');
  writeFile(dir, 'old.js', 'old\n');
  writeFile(dir, 'docs/readme.md', '# readme\n');
  commitAll(dir, 'init');

  git(dir, ['checkout', '-q', '-b', 'feature']);
  writeFile(dir, 'src/a.js', 'export const a = 2;\nexport const b = 3;\n');
  writeFile(dir, 'src/new.js', 'export const n = 1;\n');
  fs.unlinkSync(path.join(dir, 'old.js'));
  git(dir, ['mv', 'src/c.js', 'src/d.js']);
  commitAll(dir, 'feature base');

  // staged-only change on top
  writeFile(dir, 'docs/readme.md', '# readme v2\n');
  git(dir, ['add', 'docs/readme.md']);
  writeFile(dir, 'unstaged.js', 'export const x = 1;\n');

  const staged = listChangedFiles({ cwd: dir, mode: 'staged' });
  assert.deepEqual(staged.map((entry) => entry.path), ['docs/readme.md']);
  assert.equal(staged[0].status, 'modified');
  assert.equal(staged[0].insertions, 1);
  assert.equal(staged[0].deletions, 1);

  const range = listChangedFiles({ cwd: dir, mode: 'range', base: 'main', head: 'HEAD' });
  const rangeByPath = new Map(range.map((entry) => [entry.path, entry]));
  assert.equal(rangeByPath.get('src/a.js').status, 'modified');
  assert.equal(rangeByPath.get('src/new.js').status, 'added');
  assert.equal(rangeByPath.get('old.js').status, 'deleted');
  assert.equal(rangeByPath.get('src/d.js').status, 'renamed');
  assert.equal(rangeByPath.get('src/d.js').oldPath, 'src/c.js');
  assert.equal(rangeByPath.has('unstaged.js'), false, 'range mode compares commits only');

  const commit = listChangedFiles({ cwd: dir, mode: 'commit', commit: 'HEAD' });
  assert.deepEqual(commit.map((entry) => entry.path).sort(), [...rangeByPath.keys()].sort());

  // root commit mode compares against the empty tree
  const rootCommit = listChangedFiles({ cwd: dir, mode: 'commit', commit: 'main' });
  assert.deepEqual(rootCommit.map((entry) => entry.path).sort(), ['docs/readme.md', 'old.js', 'src/a.js', 'src/c.js']);
});

test('git: filePatch, untracked synthesis and parsePatchNewLines', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'src/a.js', 'line1\nline2\nline3\n');
  commitAll(dir, 'init');
  writeFile(dir, 'src/a.js', 'line1\nLINE2\nline3\nline4\n');
  writeFile(dir, 'brand-new.js', 'const a = 1;\nconst b = 2;\n');

  const tracked = filePatch({ cwd: dir, path: 'src/a.js', mode: 'workspace', status: 'modified' });
  assert.match(tracked, /^diff --git a\/src\/a\.js b\/src\/a\.js/m);
  const parsedTracked = parsePatchNewLines(tracked);
  assert.equal(parsedTracked.hunks.length >= 1, true);
  assert.equal(parsedTracked.newLines.has(2), true, 'changed new line is in the set');
  assert.equal(parsedTracked.newLines.has(1), true, 'context new line is in the set');

  const untracked = filePatch({ cwd: dir, path: 'brand-new.js', mode: 'workspace', status: 'untracked' });
  assert.match(untracked, /^diff --git a\/brand-new\.js b\/brand-new\.js/m);
  assert.match(untracked, /^new file mode 100644$/m);
  assert.match(untracked, /^--- \/dev\/null$/m);
  assert.match(untracked, /^\+\+\+ b\/brand-new\.js$/m);
  assert.match(untracked, /^\+const a = 1;$/m);
  const parsedUntracked = parsePatchNewLines(untracked);
  assert.deepEqual([...parsedUntracked.newLines], [1, 2]);

  const scanPatch = filePatch({ cwd: dir, path: 'brand-new.js', mode: 'scan' });
  assert.equal(scanPatch, untracked);

  const deletion = filePatch({ cwd: dir, path: 'src/a.js', mode: 'range', base: 'HEAD', head: 'HEAD' });
  assert.equal(deletion, '', 'no diff between HEAD and itself');
});

test('git: parsePatchNewLines handles multi-hunk additions/context/deletions', () => {
  const patch = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,3 +1,4 @@',
    ' context',
    '-old',
    '+new1',
    '+new2',
    ' context2',
    '@@ -10,2 +11,2 @@',
    ' ctx',
    '-removed',
    '+added',
  ].join('\n');
  const { newLines, hunks } = parsePatchNewLines(patch);
  assert.deepEqual([...newLines].sort((a, b) => a - b), [1, 2, 3, 4, 11, 12]);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, '@@ -1,3 +1,4 @@');
  assert.equal(parsePatchNewLines('').newLines.size, 0);
});

// ---------------------------------------------------------------------------
// scope: gates / coverage / scan
// ---------------------------------------------------------------------------

test('scope: 6-gate exclusion order, user_include override, counts and coverage (scan mode)', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'src/app.js', 'const a = 1;\n');
  writeFile(dir, 'src/excluded.js', 'const e = 1;\n');
  writeFile(dir, 'src/forced.xyz', 'forced content\n');
  writeFile(dir, 'src/mystery.zzz', 'mystery\n');
  writeFile(dir, 'src/both.js', 'const both = 1;\n');
  writeFile(dir, 'src/huge.js', `// ${'x'.repeat(200)}\n`);
  writeFile(dir, 'src/api.generated.js', 'export const generated = 1;\n');
  writeFile(dir, 'secret/.env', 'SECRET=1\n');
  writeFile(dir, 'yarn.lock', '# lock\n');
  writeFile(dir, 'data.bin', Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  writeFile(dir, 'dist/bundle.js', 'bundle\n');
  writeFile(dir, 'docs/readme.md', '# doc\n');
  writeFile(dir, 'main.go', 'package main\n');
  commitAll(dir, 'init');

  const config = baseConfig(dir, {
    scope: {
      maxFileBytes: 64,
      exclude: ['**/excluded.js', '**/both.js', '**/*.bin', '**/.env'],
      include: ['**/forced.xyz', '**/both.js'],
      skipGlobs: [...DEFAULTS.scope.skipGlobs, '**/*.generated.js'],
    },
  });
  const scope = createScope({ cwd: dir, mode: 'scan', config });
  assert.equal(scope.schemaVersion, 1);
  assert.match(scope.runId, RUN_ID_RE);
  assert.equal(scope.repo.name, path.basename(dir));
  assert.equal(scope.mode, 'scan');

  const byPath = new Map(scope.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('src/app.js').reviewable, true);
  assert.equal(byPath.get('src/app.js').status, 'existing');
  assert.equal(byPath.get('src/app.js').language, 'js');
  assert.equal(byPath.get('src/app.js').excludeReason, null);
  assert.equal(byPath.get('src/mystery.zzz').excludeReason, 'unsupported_ext');
  assert.equal(byPath.get('src/mystery.zzz').reviewable, false);
  assert.equal(byPath.get('src/forced.xyz').excludeReason, 'user_include', 'include forces reviewable and wins over unsupported_ext');
  assert.equal(byPath.get('src/forced.xyz').reviewable, true);
  assert.equal(byPath.get('src/excluded.js').excludeReason, 'user_exclude');
  assert.equal(byPath.get('src/both.js').excludeReason, 'user_exclude', 'user exclude is evaluated before user include');
  assert.equal(byPath.get('src/huge.js').excludeReason, 'too_large');
  assert.equal(byPath.get('src/api.generated.js').excludeReason, 'default_path');
  assert.equal(byPath.get('secret/.env').excludeReason, 'secret', 'secret gate wins over user exclude');
  assert.equal(byPath.get('yarn.lock').excludeReason, 'unsupported_ext');
  assert.equal(byPath.get('data.bin').excludeReason, 'binary', 'binary gate wins over user exclude');
  assert.equal(byPath.get('docs/readme.md').reviewable, true);
  assert.equal(byPath.get('main.go').reviewable, true);
  assert.equal(byPath.has('node_modules/pkg/index.js'), false, 'scan prunes default-skip directories');
  assert.equal(byPath.has('dist/bundle.js'), false, 'scan prunes default-skip directories');
  for (const file of scope.files) {
    assert.equal(file.path.includes('\\'), false);
    assert.equal(typeof file.bytes, 'number');
  }

  assert.equal(scope.counts.total, scope.files.length);
  assert.equal(scope.counts.reviewable, scope.files.filter((file) => file.reviewable).length);
  assert.equal(scope.counts.excluded, scope.counts.total - scope.counts.reviewable);
  assert.equal(scope.coverage.complete, false);
  assert.deepEqual([...scope.coverage.unreviewed].sort(), ['src/huge.js', 'src/mystery.zzz', 'yarn.lock'].sort());

  // unsupported extension helpers
  assert.equal(languageForPath('a.ts'), 'ts');
  assert.equal(languageForPath('a.py'), 'python');
  assert.equal(languageForPath('a.png'), null);
  assert.equal(languageForPath('Dockerfile'), 'dockerfile');
  assert.equal(SUPPORTED_EXTS['.ts'], 'ts');
});

test('scope: deleted and renamed files, workspace/path filter, path is repo-relative', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'deleted.js', 'gone\n');
  writeFile(dir, 'keep.js', 'keep\n');
  writeFile(dir, 'src/other.js', 'other\n');
  commitAll(dir, 'init');
  fs.unlinkSync(path.join(dir, 'deleted.js'));
  writeFile(dir, 'keep.js', 'keep v2\n');
  writeFile(dir, 'src/other.js', 'other v2\n');

  const config = baseConfig(dir);
  const scope = createScope({ cwd: dir, mode: 'workspace', config, path: 'src' });
  assert.deepEqual(scope.files.map((file) => file.path), ['src/other.js'], '--path filters to a subtree');
  assert.equal(scope.files[0].status, 'modified');

  const full = createScope({ cwd: dir, mode: 'workspace', config });
  const byPath = new Map(full.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('deleted.js').excludeReason, 'deleted');
  assert.equal(byPath.get('deleted.js').reviewable, false);
  assert.equal(byPath.get('keep.js').reviewable, true);
  assert.equal(full.range.base, null);
  assert.equal(full.range.mergeBase, null);

  // range scope records merge-base, commit scope records the commit
  git(dir, ['checkout', '-q', '-b', 'feature']);
  commitAll(dir, 'feature');
  const rangeScope = createScope({ cwd: dir, mode: 'range', base: 'main', head: 'HEAD', config });
  assert.equal(rangeScope.range.base, 'main');
  assert.equal(rangeScope.range.head, 'HEAD');
  assert.equal(typeof rangeScope.range.mergeBase, 'string');
  const commitScope = createScope({ cwd: dir, mode: 'commit', commit: 'HEAD', config });
  assert.equal(commitScope.range.commit, 'HEAD');
  assert.throws(() => createScope({ cwd: dir, mode: 'commit', config }), (err) => err.code === 'USAGE');
  assert.throws(() => createScope({ cwd: dir, mode: 'nonsense', config }), (err) => err.code === 'USAGE');
  assert.throws(() => createScope({ cwd: dir, mode: 'workspace', config, runId: 'bad-id' }), (err) => err.code === 'USAGE');
  const forcedId = createScope({ cwd: dir, mode: 'workspace', config, runId: 'run-20260101-010101-beef' });
  assert.equal(forcedId.runId, 'run-20260101-010101-beef');
});

test('scope: non-git directory is rejected for diff modes but scan works', (t) => {
  const dir = mkTemp('cr-nogit-');
  t.after(() => removeTemp(dir));
  writeFile(dir, 'a.js', 'const a = 1;\n');
  const config = baseConfig(dir);
  assert.throws(() => createScope({ cwd: dir, mode: 'workspace', config }), (err) => err.code === 'USAGE');
  const scan = createScope({ cwd: dir, mode: 'scan', config });
  assert.equal(scan.files.length, 1);
  assert.equal(scan.files[0].path, 'a.js');
});

// ---------------------------------------------------------------------------
// rules: glob matching / frontmatter / loading / resolution
// ---------------------------------------------------------------------------

test('rules: matchGlob supports **, *, ?, {a,b}, classes and trailing slash', () => {
  const cases = [
    ['**/*.lock', 'a/b/x.lock', true],
    ['**/*.lock', 'x.lock', true],
    ['**/*.lock', 'x.js', false],
    ['**/node_modules/**', 'node_modules/x.js', true],
    ['**/node_modules/**', 'a/node_modules/pkg/x.js', true],
    ['**/dist/**', 'src/dist/a.js', true],
    ['dist/**', 'dist/a.js', true],
    ['dist/**', 'src/dist/a.js', false],
    ['a/**/b.js', 'a/b.js', true],
    ['a/**/b.js', 'a/x/b.js', true],
    ['a/**/b.js', 'a/x/y/b.js', true],
    ['src/**', 'src/a/b.js', true],
    ['src/', 'src/a/b.js', true],
    ['src/', 'src', true],
    ['*.{js,ts}', 'a/b/c.ts', true],
    ['*.{js,ts}', 'a/b/c.py', false],
    ['**/*.{test,spec}.{js,ts}', 'src/a.test.ts', true],
    ['**/*.{test,spec}.{js,ts}', 'src/a.spec.js', true],
    ['**/*.{test,spec}.{js,ts}', 'src/a.ts', false],
    ['?.js', 'a.js', true],
    ['?.js', 'ab.js', false],
    ['[jt]s', 'js', true],
    ['[jt]s', 'ts', true],
    ['[!jt]s', 'xs', true],
    ['[!jt]s', 'js', false],
    ['**', 'a/b/c', true],
    ['src/*.js', 'src/a.js', true],
    ['src/*.js', 'src/a/b.js', false],
    ['\\*.js', '*.js', true],
    ['./src/**', 'src/a.js', true],
  ];
  for (const [pattern, filePath, expected] of cases) {
    assert.equal(matchGlob(pattern, filePath), expected, `${pattern} vs ${filePath}`);
  }
});

test('rules: frontmatter parsing (quotes, inline arrays, block arrays, booleans)', () => {
  const text = [
    '---',
    'id: "proj-rules"',
    "title: '项目规则'",
    'paths: ["src/**", "**/*.ts"]',
    'severityHint: major',
    'alwaysApply: true',
    'blockList:',
    '  - "a/**"',
    '  - b/*.js',
    '---',
    '',
    'BODY LINE ONE',
    'BODY LINE TWO',
  ].join('\n');
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.id, 'proj-rules');
  assert.equal(data.title, '项目规则');
  assert.deepEqual(data.paths, ['src/**', '**/*.ts']);
  assert.equal(data.severityHint, 'major');
  assert.equal(data.alwaysApply, true);
  assert.deepEqual(data.blockList, ['a/**', 'b/*.js']);
  assert.match(body, /BODY LINE ONE\nBODY LINE TWO/);

  const noFrontmatter = parseFrontmatter('# just markdown\n');
  assert.equal(noFrontmatter.hasFrontmatter, false);
  assert.equal(noFrontmatter.body, '# just markdown\n');
});

test('rules: load builtin + project rules, project overrides builtin, resolution budget', (t) => {
  const dir = mkTemp('cr-rules-');
  t.after(() => removeTemp(dir));
  writeFile(dir, '.review/rules/proj-custom.md', [
    '---',
    'id: proj-custom',
    'title: 项目自定义规则',
    'paths: ["src/**", "**/*.ts"]',
    'severityHint: major',
    'alwaysApply: false',
    '---',
    'PROJECT CUSTOM BODY',
  ].join('\n'));
  writeFile(dir, '.review/rules/proj-always.md', [
    '---',
    'id: proj-always',
    'title: 总则',
    'alwaysApply: true',
    '---',
    'ALWAYS BODY',
  ].join('\n'));
  writeFile(dir, '.review/rules/core-correctness.md', [
    '---',
    'id: core-correctness',
    'title: 覆盖内置',
    'alwaysApply: true',
    '---',
    'PROJECT OVERRIDE BODY',
  ].join('\n'));

  const config = baseConfig(dir);
  const rules = loadRules({ cwd: dir, config, builtinDir: BUILTIN_RULES_DIR });
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  assert.equal(byId.get('core-correctness').source, 'project', 'project rule overrides builtin by id');
  assert.equal(byId.get('core-correctness').title, '覆盖内置');
  assert.equal(byId.get('proj-custom').source, 'project');
  assert.equal(byId.get('proj-always').alwaysApply, true);
  assert.equal(byId.get('core-security').source, 'builtin');
  assert.equal(byId.get('lang-python').source, 'builtin');
  const ids = rules.map((rule) => rule.id);
  assert.deepEqual(ids, [...ids].sort(), 'rules are sorted by id for determinism');

  // builtin can be disabled entirely
  const disabled = loadRules({ cwd: dir, config: baseConfig(dir, { rules: { builtin: false } }), builtinDir: BUILTIN_RULES_DIR });
  assert.equal(disabled.every((rule) => rule.source === 'project'), true);
  assert.equal(disabled.length, 3);

  // resolution: path matching, alwaysApply, and char budget truncation
  const matched = resolveRulesForFile({ path: 'src/app.ts', rules, maxChars: 20000 });
  assert.equal(matched.some((rule) => rule.id === 'proj-always'), true);
  assert.equal(matched.some((rule) => rule.id === 'proj-custom'), true);
  assert.equal(matched.some((rule) => rule.id === 'core-security'), true);
  assert.equal(matched.some((rule) => rule.id === 'lang-python'), false, 'python pack does not match ts');

  const noMatch = resolveRulesForFile({ path: 'README.md', rules: disabled, maxChars: 20000 });
  assert.deepEqual(noMatch.map((rule) => rule.id), ['core-correctness', 'proj-always']);

  const tiny = resolveRulesForFile({ path: 'src/app.ts', rules, maxChars: 10 });
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0].truncated, true);
  assert.equal(tiny[0].body.endsWith('…'), true);
  assert.equal(tiny[0].body.length > 0, true);
  assert.equal(tiny[0].body.length <= 12, true);
});

// ---------------------------------------------------------------------------
// plan: effort lenses + grouping + rules + patches
// ---------------------------------------------------------------------------

test('plan: effort -> lenses, deep rounds, grouping modes and rule binding', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  for (let i = 1; i <= 12; i += 1) writeFile(dir, `src/f${String(i).padStart(2, '0')}.js`, `export const v${i} = ${i};\n`);
  for (let i = 1; i <= 3; i += 1) writeFile(dir, `docs/d${i}.md`, `# doc ${i}\n`);
  for (let i = 1; i <= 2; i += 1) writeFile(dir, `tests/t${i}.test.js`, `test('t${i}', () => {});\n`);
  writeFile(dir, 'index.js', 'export const root = 1;\n');
  commitAll(dir, 'init');

  const config = baseConfig(dir, { plan: { maxFilesPerUnit: 5, maxLinesPerUnit: 10000 } });
  const scope = createScope({ cwd: dir, mode: 'scan', config });
  const rules = loadRules({ cwd: dir, config, builtinDir: BUILTIN_RULES_DIR });

  const quick = buildPlan({
    scope,
    config: baseConfig(dir, { plan: { maxFilesPerUnit: 5, maxLinesPerUnit: 10000 }, review: { effort: 'quick' } }),
    effort: 'quick',
    rules,
  });
  assert.equal(quick.schemaVersion, 1);
  assert.equal(quick.runId, scope.runId);
  assert.equal(quick.effort, 'quick');
  assert.deepEqual(quick.lenses, [...EFFORT_LENSES.quick]);
  assert.deepEqual(quick.lenses, ['intent', 'correctness']);
  assert.equal(quick.units.length, 6, 'src(12/5 -> 3 units) + docs + tests + root');
  const sizes = quick.units.map((unit) => unit.files.length);
  const srcUnitSizes = quick.units
    .filter((unit) => unit.files.every((file) => file.path.startsWith('src/')))
    .map((unit) => unit.files.length);
  assert.deepEqual(srcUnitSizes, [5, 5, 2], 'greedy packing respects maxFilesPerUnit');
  assert.equal(sizes.reduce((sum, count) => sum + count, 0), scope.counts.reviewable);
  const unitIds = quick.units.map((unit) => unit.unitId);
  assert.deepEqual(unitIds, ['u01', 'u02', 'u03', 'u04', 'u05', 'u06']);
  for (const unit of quick.units) {
    assert.equal(unit.stats.files, unit.files.length);
    assert.equal(unit.stats.changedLines, unit.files.reduce((sum, file) => sum + file.newLineCount, 0));
    assert.equal(unit.stats.changedLines > 0, true, 'scan mode counts existing lines as changed lines');
    assert.deepEqual(unit.lenses, quick.lenses);
    assert.equal(unit.rules.some((rule) => rule.id === 'core-correctness'), true);
    const ruleIds = unit.rules.map((rule) => rule.id);
    assert.deepEqual(ruleIds, [...ruleIds].sort(), 'rules are ordered by id');
    for (const file of unit.files) {
      assert.deepEqual(Object.keys(file).sort(), ['newLineCount', 'patch', 'path']);
      assert.match(file.patch, /^diff --git /);
      assert.equal(file.newLineCount > 0, true);
    }
  }

  const standard = buildPlan({ scope, config, effort: 'standard', rules });
  assert.deepEqual(
    standard.lenses,
    EFFORT_LENSES.standard.filter((lens) => !SCAN_SKIP_LENSES.includes(lens)),
    'scan mode skips unit-scope-unfriendly lenses',
  );
  const deep = buildPlan({ scope, config, effort: 'deep', rules });
  assert.equal(deep.lenses.length, LENSES.length - SCAN_SKIP_LENSES.length);
  assert.equal(deep.rounds >= 2, true, 'deep effort forces rounds >= 2');

  const perfile = buildPlan({ scope, config: baseConfig(dir, { plan: { maxFilesPerUnit: 5, maxLinesPerUnit: 10000, groupBy: 'perfile' } }), effort: 'quick', rules });
  assert.equal(perfile.units.length, scope.files.filter((file) => file.reviewable).length);
  const none = buildPlan({ scope, config: baseConfig(dir, { plan: { maxFilesPerUnit: 5, maxLinesPerUnit: 10000, groupBy: 'none' } }), effort: 'quick', rules });
  assert.equal(none.units.length, 1);
  assert.equal(none.units[0].files.length, scope.counts.reviewable);

  // no rules supplied -> empty rule list, no throw
  const bare = buildPlan({ scope, config, effort: 'quick' });
  assert.equal(bare.units.every((unit) => unit.rules.length === 0), true);

  // invalid effort -> CONFIG error
  assert.throws(() => buildPlan({ scope, config, effort: 'extreme' }), (err) => err.code === 'CONFIG');
});

test('plan: skippedFiles ledger and maxLinesPerUnit splitting', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'a.js', 'const a = 1;\n');
  writeFile(dir, 'b.js', 'const b = 1;\n');
  writeFile(dir, 'c.js', 'const c = 1;\n');
  writeFile(dir, 'weird.xyz', 'nope\n');
  commitAll(dir, 'init');
  const config = baseConfig(dir, { plan: { maxFilesPerUnit: 10, maxLinesPerUnit: 2 } });
  const scope = createScope({ cwd: dir, mode: 'scan', config });
  const plan = buildPlan({ scope, config, effort: 'quick' });
  assert.deepEqual(plan.skippedFiles, [{ path: 'weird.xyz', reason: 'unsupported_ext' }]);
  assert.equal(plan.units.length, 2, 'line budget splits one-line-per-file units');
  assert.deepEqual(plan.units.map((unit) => unit.files.length), [2, 1]);
});

test('plan: scan grouping enforces BOTH maxFilesPerUnit and maxLinesPerUnit', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  // 12 files x 5 lines in one directory: 10-file cap and 12-line cap both apply.
  for (let i = 1; i <= 12; i += 1) {
    const lines = Array.from({ length: 5 }, (_, n) => `const v${i}_${n} = ${n};`).join('\n');
    writeFile(dir, `lib/f${String(i).padStart(2, '0')}.js`, `${lines}\n`);
  }
  writeFile(dir, 'solo.js', `${Array.from({ length: 50 }, (_, n) => `const s${n} = ${n};`).join('\n')}\n`);
  commitAll(dir, 'init');
  const config = baseConfig(dir, { plan: { maxFilesPerUnit: 10, maxLinesPerUnit: 12 } });
  const scope = createScope({ cwd: dir, mode: 'scan', path: 'lib', config });
  assert.equal(scope.counts.reviewable, 12);
  const plan = buildPlan({ scope, config, effort: 'quick' });
  assert.equal(plan.units.length, 6, '12 files / 2 per 10-line budget => 6 units');
  for (const unit of plan.units) {
    assert.equal(unit.stats.changedLines <= 12, true, 'line budget is enforced');
    assert.equal(unit.files.length <= 2, true, 'file budget derived from line budget is enforced');
    const newLineSum = unit.files.reduce((sum, file) => sum + file.newLineCount, 0);
    assert.equal(unit.stats.changedLines, newLineSum);
    assert.equal(newLineSum, 10);
  }

  // A single file may exceed the line budget on its own.
  const soloConfig = baseConfig(dir, { plan: { maxFilesPerUnit: 10, maxLinesPerUnit: 12 } });
  const allScope = createScope({ cwd: dir, mode: 'scan', config: soloConfig });
  const allPlan = buildPlan({ scope: allScope, config: soloConfig, effort: 'quick' });
  const soloUnits = allPlan.units.filter((unit) => unit.files.some((file) => file.path === 'solo.js'));
  assert.equal(soloUnits.length, 1);
  assert.equal(soloUnits[0].files.length, 1, 'oversized single file is not split and is not merged');
  assert.equal(soloUnits[0].stats.changedLines, 50);
});

test('plan: scan mode drops the tests lens unless explicitly requested', (t) => {
  const dir = initRepo();
  t.after(() => removeTemp(dir));
  writeFile(dir, 'lib/a.js', 'export const a = 1;\n');
  commitAll(dir, 'init');
  const config = baseConfig(dir);
  const scanScope = createScope({ cwd: dir, mode: 'scan', path: 'lib', config });
  const plan = buildPlan({ scope: scanScope, config, effort: 'standard' });
  assert.equal(plan.lenses.includes('tests'), false, 'scan units contain only the reviewed file');
  assert.equal(plan.lenses.includes('correctness'), true);
  const explicit = buildPlan({ scope: scanScope, config, effort: 'standard', lenses: ['tests'] });
  assert.deepEqual(explicit.lenses, ['tests'], 'an explicit lens selection always wins');
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('store: runId format, createRun meta, json io, latest/list/resolve', (t) => {
  const dir = mkTemp('cr-store-');
  t.after(() => removeTemp(dir));
  const config = baseConfig(dir);

  const generated = createRunId();
  assert.match(generated, RUN_ID_RE);
  assert.equal(isRunId(generated), true);
  assert.equal(isRunId('not-a-run'), false);

  const scope = {
    schemaVersion: 1,
    runId: generated,
    repo: { root: dir, name: path.basename(dir) },
    mode: 'workspace',
    files: [],
    counts: { total: 0, reviewable: 0, excluded: 0, insertions: 0, deletions: 0 },
    coverage: { complete: true, unreviewed: [] },
  };
  const run = createRun({ cwd: dir, config, mode: 'workspace', scope });
  assert.equal(run.runId, generated);
  assert.equal(fs.existsSync(path.join(run.runDir, 'meta.json')), true);
  assert.equal(run.meta.runId, generated);
  assert.equal(run.meta.mode, 'workspace');
  assert.equal(fs.readdirSync(run.runDir).some((name) => name.endsWith('.tmp')), false, 'no temp files left behind');

  assert.equal(writeJson(run.runDir, 'scope.json', scope), path.join(run.runDir, 'scope.json'));
  const readScope = readJson(run.runDir, 'scope');
  assert.deepEqual(readScope.files, []);
  assert.equal(readJson(run.runDir, 'missing.json'), null);
  const loaded = readRun(run.runDir);
  assert.equal(loaded.runId, generated);
  assert.equal(loaded.scope.runId, generated);
  assert.equal(loaded.plan, null);
  assert.equal(latestRun(dir, config), run.runDir);

  // secret-ish fields never land in meta.json
  const secretConfig = baseConfig(dir, { model: { apiKey: 'SUPER_SECRET_VALUE' } });
  const secretRun = createRun({ cwd: dir, config: secretConfig, mode: 'staged', scope: { runId: 'run-20990101-000000-abcd', repo: { root: dir, name: 'x' }, mode: 'staged' } });
  const metaText = fs.readFileSync(path.join(secretRun.runDir, 'meta.json'), 'utf8');
  assert.equal(metaText.includes('SUPER_SECRET_VALUE'), false, 'no accidental secrets in meta.json');

  // explicit duplicate run id is rejected
  assert.throws(
    () => createRun({ cwd: dir, config, mode: 'workspace', scope: { runId: generated } }),
    (err) => err.code === 'USAGE',
  );

  const listed = listRuns(dir, config);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].runId, 'run-20990101-000000-abcd', 'newest first by createdAt');
  assert.equal(listed[1].runId, generated);
  assert.equal(latestRun(dir, config), path.join(path.resolve(dir, '.review/runs'), 'run-20990101-000000-abcd'));
  assert.equal(resolveRunDir(dir, config, 'latest'), latestRun(dir, config));
  assert.equal(resolveRunDir(dir, config, generated), run.runDir);
  assert.equal(resolveRunDir(dir, config, run.runDir), run.runDir);
  assert.throws(() => resolveRunDir(dir, config, 'run-20000101-000000-dead'), (err) => err.code === 'USAGE');
  assert.throws(() => resolveRunDir(dir, config, ''), (err) => err.code === 'USAGE');

  // writeJson accepts names with or without .json
  writeJson(run.runDir, 'plan.json', { units: [] });
  assert.equal(readJson(run.runDir, 'plan').units.length, 0);
  assert.equal(fs.readdirSync(run.runDir).some((name) => name.endsWith('.tmp')), false);

  // runs dir is configurable
  const custom = baseConfig(dir, { report: { outDir: 'custom-runs' } });
  const customRun = createRun({ cwd: dir, config: custom, mode: 'scan', scope: { runId: 'run-20990101-000000-ffff' } });
  assert.equal(customRun.runDir.startsWith(path.join(dir, 'custom-runs')), true);
});

test('store: readRun rejects a missing directory', (t) => {
  const dir = mkTemp('cr-store-missing-');
  t.after(() => removeTemp(dir));
  assert.throws(() => readRun(path.join(dir, 'nope')), (err) => err.code === 'USAGE');
});
