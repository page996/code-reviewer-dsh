#!/usr/bin/env node
/**
 * dsh-code-reviewer - git hooks contract test (CONTRACT.md §7 hooks, §10 tests).
 *
 * Proves, against a REAL temporary git repository, that the installed hooks do what the
 * contract says:
 *
 *   1. `node bin/review.mjs install-hooks --repo <tmp>` installs
 *      `.githooks/pre-commit` + `.githooks/pre-push` (LF, invoking bin/review.mjs) and sets
 *      `core.hooksPath=.githooks`;
 *   2. with `.review/config.json` gate.commands = `node -e "process.exit(1)"` a
 *      `git commit` FAILS (nonzero exit) and the output mentions the review/gate/hook;
 *   3. with gate.commands = `node -e "process.exit(0)"` the retried `git commit` SUCCEEDS;
 *   4. `REVIEW_SKIP_HOOKS=1` lets a commit through even when the gate command fails.
 *
 * Deliberately a standalone script (not `node:test`): it shells out to git, never touches the
 * network, needs no npm dependencies, and must also run on Windows (Git for Windows). On POSIX
 * it additionally asserts the installed hooks are executable, because git silently skips
 * non-executable hooks on Linux/macOS.
 *
 * Usage: node test/hooks.contract.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const CLI = path.join(REPO_ROOT, 'bin', 'review.mjs');
const IS_WINDOWS = process.platform === 'win32';

const BLOCKING_GATE = 'node -e "process.exit(1)"';
const PASSING_GATE = 'node -e "process.exit(0)"';
const GIT_TIMEOUT_MS = 180_000;
const HOOK_NAMES = ['pre-commit', 'pre-push'];

let checks = 0;
const failures = [];

function fail(name, error) {
  checks += 1;
  const message = error instanceof Error ? error.message : String(error);
  failures.push(name);
  console.error(`FAIL  ${name}`);
  for (const line of message.split(/\r?\n/)) {
    console.error(`      ${line}`);
  }
}

function pass(name) {
  checks += 1;
  console.log(`PASS  ${name}`);
}

/** Runs one contract check; a thrown Error is recorded as a FAIL and the test continues. */
function check(name, fn) {
  try {
    fn();
    pass(name);
    return true;
  } catch (error) {
    fail(name, error);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** Environment for child processes: never inherit ambient git-hook or repo-location state. */
function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (!Object.prototype.hasOwnProperty.call(extra, 'REVIEW_SKIP_HOOKS')) {
    delete env.REVIEW_SKIP_HOOKS;
  }
  return env;
}

function exec(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env ?? baseEnv(),
    encoding: 'utf8',
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    throw new Error(`failed to spawn ${file}: ${result.error.message}`);
  }
  return result;
}

function describeCommand(file, args) {
  return [file, ...args].join(' ');
}

function git(cwd, args, options = {}) {
  return exec('git', args, { ...options, cwd });
}

function gitOk(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new Error(
      [
        `${describeCommand('git', args)} exited with ${result.status}`,
        '--- stdout ---',
        result.stdout,
        '--- stderr ---',
        result.stderr,
      ].join('\n'),
    );
  }
  return result;
}

function cli(cwd, args, options = {}) {
  return exec(process.execPath, [CLI, ...args], { ...options, cwd });
}

function fullOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function writeConfig(repoDir, gateCommands) {
  const configDir = path.join(repoDir, '.review');
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    // Explicit commands + autodetect:false keeps the contract test independent of the
    // fixture repo's scripts and of ambient package managers.
    gate: { commands: gateCommands, autodetect: false },
  };
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeAndStage(repoDir, name, content) {
  const file = path.join(repoDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  gitOk(repoDir, ['add', '--', name]);
}

function headSha(repoDir) {
  return gitOk(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
}

function commit(repoDir, message, extraEnv = {}) {
  return git(repoDir, ['commit', '-m', message], { env: baseEnv(extraEnv) });
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.error(`WARN  could not remove temp directory ${dir}: ${error.message}`);
  }
}

/**
 * Fixture + install checks. Returns false when a prerequisite failed, so later checks do not
 * produce misleading cascading failures.
 */
function runChecks(tmp) {
  // --- fixture -------------------------------------------------------------------------
  if (
    !check('fixture: throwaway git repo with an initial commit', () => {
      gitOk(tmp, ['init', '--quiet']);
      gitOk(tmp, ['config', 'user.name', 'DSH Hooks Contract']);
      gitOk(tmp, ['config', 'user.email', 'hooks-contract@example.invalid']);
      gitOk(tmp, ['config', 'commit.gpgsign', 'false']);
      writeAndStage(tmp, 'tracked.txt', 'line 1\n');
      gitOk(tmp, ['commit', '--quiet', '-m', 'initial commit']);
      assert(fs.existsSync(path.join(tmp, 'tracked.txt')), 'fixture file tracked.txt is missing');
    })
  ) {
    return;
  }

  // --- install hooks with a failing deterministic gate ---------------------------------
  if (
    !check('install-hooks: writes .githooks/{pre-commit,pre-push} and sets core.hooksPath', () => {
      writeConfig(tmp, [BLOCKING_GATE]);
      const installed = cli(tmp, ['install-hooks', '--repo', tmp]);
      assert(
        installed.status === 0,
        `install-hooks exited ${installed.status}\n--- stdout ---\n${installed.stdout}\n--- stderr ---\n${installed.stderr}`,
      );
      const hooksPath = gitOk(tmp, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
      assert(hooksPath === '.githooks', `core.hooksPath is "${hooksPath}", expected ".githooks"`);
      for (const hookName of HOOK_NAMES) {
        const hookFile = path.join(tmp, '.githooks', hookName);
        assert(fs.existsSync(hookFile), `missing hook file ${hookFile}`);
        const content = fs.readFileSync(hookFile, 'utf8');
        assert(content.trim().length > 0, `${hookName} is empty`);
        assert(!content.includes('\r'), `${hookName} must use LF line endings (POSIX sh)`);
        assert(content.includes('review.mjs'), `${hookName} should invoke bin/review.mjs (CONTRACT §7)`);
      }
    })
  ) {
    return;
  }

  if (IS_WINDOWS) {
    console.log('SKIP  install-hooks: POSIX executable-bit check (not meaningful on Windows)');
  } else {
    check('install-hooks: hooks are executable on POSIX (git silently skips them otherwise)', () => {
      for (const hookName of HOOK_NAMES) {
        const mode = fs.statSync(path.join(tmp, '.githooks', hookName)).mode;
        assert(
          (mode & 0o111) !== 0,
          `${hookName} is not executable (mode ${(mode & 0o777).toString(8)}); installHooks must chmod 0755`,
        );
      }
    });
  }

  // --- 1. a failing gate.commands must block the commit --------------------------------
  if (
    !check('blocking gate: git commit FAILS and reports the review/gate failure', () => {
      writeAndStage(tmp, 'blocked.txt', 'this commit must be rejected\n');
      const before = headSha(tmp);
      const result = commit(tmp, 'should be blocked by the pre-commit hook');
      assert(
        result.status !== 0,
        `git commit unexpectedly succeeded (exit 0)\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
      assert(result.stderr.trim().length > 0, 'blocked commit produced no stderr output at all');
      assert(
        /(review|gate|hook|block)/i.test(result.stderr),
        `stderr does not mention the review/gate/hook failure\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`,
      );
      assert(headSha(tmp) === before, 'HEAD moved even though git commit failed');
    })
  ) {
    return;
  }

  // --- 2. the same commit succeeds once the gate passes --------------------------------
  if (
    !check('passing gate: git commit SUCCEEDS after gate.commands is fixed', () => {
      writeConfig(tmp, [PASSING_GATE]);
      // The index still holds the files staged by the failed attempt; restage one to be explicit.
      writeAndStage(tmp, 'tracked.txt', 'line 1\nline 2\n');
      const before = headSha(tmp);
      const result = commit(tmp, 'should pass the pre-commit hook');
      assert(
        result.status === 0,
        `git commit failed (exit ${result.status})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
      assert(headSha(tmp) !== before, 'HEAD did not move although git commit exited 0');
    })
  ) {
    return;
  }

  // --- 3. REVIEW_SKIP_HOOKS=1 bypasses a failing hook ----------------------------------
  if (
    !check('REVIEW_SKIP_HOOKS=1 bypasses a failing gate and lets the commit through', () => {
      writeConfig(tmp, [BLOCKING_GATE]);
      writeAndStage(tmp, 'tracked.txt', 'line 1\nline 2\nline 3\n');
      const before = headSha(tmp);
      const result = commit(tmp, 'skip hooks', { REVIEW_SKIP_HOOKS: '1' });
      assert(
        result.status === 0,
        `git commit with REVIEW_SKIP_HOOKS=1 failed (exit ${result.status})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
      assert(headSha(tmp) !== before, 'HEAD did not move although the skipped-hook commit exited 0');
    })
  ) {
    return;
  }
}

function main() {
  console.log('dsh-code-reviewer - git hooks contract test (real git repo, real git commit)');
  console.log(`node ${process.version} on ${process.platform}\n`);

  if (!fs.existsSync(CLI)) {
    fail(
      'prerequisite: bin/review.mjs exists',
      `missing ${CLI}\nlib/* and bin/* must be implemented before this contract test can run.`,
    );
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-hooks-contract-'));
    try {
      runChecks(tmp);
    } catch (error) {
      fail('unexpected test error', error);
    } finally {
      cleanup(tmp);
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`PASS  hooks contract: ${checks} checks passed`);
    process.exitCode = 0;
  } else {
    console.error(`FAIL  hooks contract: ${failures.length} of ${checks} checks failed`);
    for (const name of failures) {
      console.error(`      - ${name}`);
    }
    process.exitCode = 1;
  }
}

main();
