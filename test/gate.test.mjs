/**
 * test/gate.test.mjs — gate execution + git hooks tests.
 *
 * Covers: command autodetection (package.json / pyproject / Makefile), gate
 * verdicts and exit codes (pass 0 / blocking 2 / needs-human 3 / command fail 4
 * / engine error 5), stdoutTail capture, timeout handling, gate.json output,
 * hooks install/uninstall (incl. core.hooksPath), REVIEW_SKIP_HOOKS, pre-commit
 * deterministic blocking inside a REAL temp git repo, and pre-push range scope.
 *
 * No network. Uses `node -e "..."` as the gate command payload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGate, detectGateCommands } from '../lib/gate.mjs';
import { installHooks, uninstallHooks, runHook, buildHookScript } from '../lib/hooks.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function tempDir(t, prefix = 'dcr-gate-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });
  return dir;
}

function collectLog() {
  const lines = [];
  const log = (level, message) => lines.push(`${level}: ${message}`);
  log.lines = lines;
  return log;
}

function aggregateWith({ blocking = [], counts = {}, verdict = 'pass' } = {}) {
  return {
    schemaVersion: 1,
    findings: blocking.map((item) => ({
      ...item,
      status: 'real',
      blocking: true,
      evidence: 'evidence',
      problem: item.title,
    })),
    counts: {
      blocker: 0,
      major: 0,
      minor: 0,
      needsHuman: 0,
      dropped: 0,
      ...counts,
    },
    verdict,
    blocking,
    humanAttention: [],
    errors: [],
  };
}

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
  });
  return result;
}

function gitOk(cwd, args, extraEnv = {}) {
  const result = git(cwd, args, extraEnv);
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed (${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

function initRepo(t) {
  const repo = tempDir(t, 'dcr-gate-repo-');
  gitOk(repo, ['init', '--quiet', '-b', 'main']);
  gitOk(repo, ['config', 'user.name', 'DSH Gate Test']);
  gitOk(repo, ['config', 'user.email', 'gate-test@example.invalid']);
  gitOk(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'tracked.txt'), 'line 1\n', 'utf8');
  gitOk(repo, ['add', '-A']);
  gitOk(repo, ['commit', '--quiet', '-m', 'initial commit']);
  return repo;
}

function stageFile(repo, name, content) {
  const file = join(repo, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  gitOk(repo, ['add', '--', name]);
}

const EXIT_0 = 'node -e "process.exit(0)"';
const EXIT_1 = 'node -e "process.exit(1)"';

/* ------------------------------------------------------------------------- */
/* autodetection                                                             */
/* ------------------------------------------------------------------------- */

test('gate: detectGateCommands reads package.json scripts in order', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' },
    }),
    'utf8',
  );
  const commands = detectGateCommands(dir);
  assert.deepEqual(commands.map((item) => item.id), ['lint', 'typecheck', 'test']);
  assert.deepEqual(commands.map((item) => item.cmd), ['npm run lint', 'npm run typecheck', 'npm run test']);
  for (const command of commands) assert.equal(command.required, true);
});

test('gate: detectGateCommands dedupes and probes Makefile / pytest projects', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
  writeFileSync(join(dir, 'Makefile'), 'test:\n\techo ok\n', 'utf8');
  writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n', 'utf8');
  const commands = detectGateCommands(dir);
  const cmds = commands.map((item) => item.cmd);
  assert.ok(cmds.includes('npm run test'));
  assert.ok(cmds.includes('make test'));
  assert.ok(cmds.includes('pytest'));
  assert.equal(new Set(cmds).size, cmds.length, 'commands are deduped');

  const empty = tempDir(t);
  assert.deepEqual(detectGateCommands(empty), []);
});

/* ------------------------------------------------------------------------- */
/* execution + verdicts                                                      */
/* ------------------------------------------------------------------------- */

test('gate: autodetected package.json script runs and passes (gate.json written)', async (t) => {
  const cwd = tempDir(t);
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
    'utf8',
  );
  const runDir = join(cwd, 'run');
  const gate = await runGate({
    cwd,
    config: { gate: { commands: [], autodetect: true, timeoutMs: 120000 } },
    aggregate: aggregateWith(),
    runDir,
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'pass');
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.checks.length, 1);
  assert.equal(gate.checks[0].id, 'test');
  assert.equal(gate.checks[0].cmd, 'npm run test');
  assert.equal(gate.checks[0].exit, 0);
  assert.equal(gate.checks[0].required, true);
  assert.equal(typeof gate.checks[0].durationMs, 'number');
  assert.ok(existsSync(join(runDir, 'gate.json')));
  const written = JSON.parse(readFileSync(join(runDir, 'gate.json'), 'utf8'));
  assert.equal(written.verdict, 'pass');
  assert.equal(written.exitCode, 0);
  assert.equal(written.schemaVersion, 1);
});

test('gate: explicit commands pass/fail with contract exit codes', async (t) => {
  const cwd = tempDir(t);
  const log = collectLog();
  const passing = await runGate({
    cwd,
    config: { gate: { commands: [EXIT_0], autodetect: false } },
    aggregate: aggregateWith(),
    runDir: join(cwd, 'run-pass'),
    log,
  });
  assert.equal(passing.verdict, 'pass');
  assert.equal(passing.exitCode, 0);
  assert.equal(passing.checks[0].exit, 0);

  const failing = await runGate({
    cwd,
    config: { gate: { commands: [EXIT_1], autodetect: false } },
    aggregate: aggregateWith(),
    runDir: join(cwd, 'run-fail'),
    log,
  });
  assert.equal(failing.verdict, 'fail');
  assert.equal(failing.exitCode, 4);
  assert.equal(failing.checks[0].exit, 1);
});

test('gate: optional / skipped commands do not fail the gate', async (t) => {
  const cwd = tempDir(t);
  const gate = await runGate({
    cwd,
    config: {
      gate: {
        autodetect: false,
        commands: [
          { id: 'optional', cmd: 'node -e "process.exit(9)"', required: false },
          { id: 'skipped', cmd: EXIT_1, skipped: true },
        ],
      },
    },
    aggregate: aggregateWith(),
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'pass');
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.checks[0].required, false);
  assert.equal(gate.checks[0].exit, 9);
  assert.equal(gate.checks[1].skipped, true);
  assert.equal(gate.checks[1].exit, 0);
});

test('gate: blocking findings fail with exit 2 even without commands', async (t) => {
  const cwd = tempDir(t);
  const blocking = [
    { fingerprint: 'f'.repeat(40), file: 'src/a.js', startLine: 4, severity: 'major', title: 'bug' },
  ];
  const gate = await runGate({
    cwd,
    config: { gate: { commands: [], autodetect: false } },
    aggregate: aggregateWith({ blocking, counts: { major: 1 }, verdict: 'block' }),
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'fail');
  assert.equal(gate.exitCode, 2);
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.blocking[0].title, 'bug');
});

test('gate: scan mode treats blocking findings as pre-existing (no exit 2)', async (t) => {
  const cwd = tempDir(t);
  const blocking = [
    { fingerprint: 'f'.repeat(40), file: 'src/a.js', startLine: 4, severity: 'major', title: 'bug' },
  ];
  const aggregate = aggregateWith({ blocking, counts: { major: 1 }, verdict: 'block' });
  const scanGate = await runGate({
    cwd,
    config: { gate: { commands: [], autodetect: false } },
    aggregate,
    scopeMode: 'scan',
    log: collectLog(),
  });
  assert.equal(scanGate.verdict, 'pass');
  assert.equal(scanGate.exitCode, 0);
  assert.equal(scanGate.blocking.length, 0);

  const forced = await runGate({
    cwd,
    config: { gate: { commands: [], autodetect: false, blockPreexisting: true } },
    aggregate,
    scopeMode: 'scan',
    log: collectLog(),
  });
  assert.equal(forced.verdict, 'fail');
  assert.equal(forced.exitCode, 2);
});

test('gate: command failure takes precedence over blocking findings and needs-human', async (t) => {
  const cwd = tempDir(t);
  const blocking = [
    { fingerprint: 'f'.repeat(40), file: 'src/a.js', startLine: 4, severity: 'blocker', title: 'bug' },
  ];
  const gate = await runGate({
    cwd,
    config: { gate: { commands: [EXIT_1], autodetect: false } },
    aggregate: aggregateWith({ blocking, counts: { blocker: 1, needsHuman: 1 }, verdict: 'block' }),
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'fail');
  assert.equal(gate.exitCode, 4);
});

test('gate: needs-human exits 3', async (t) => {
  const cwd = tempDir(t);
  const gate = await runGate({
    cwd,
    config: { gate: { commands: [], autodetect: false } },
    aggregate: aggregateWith({ counts: { needsHuman: 2 }, verdict: 'needs-human' }),
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'needs-human');
  assert.equal(gate.exitCode, 3);
});

test('gate: stdoutTail keeps the last 4000 characters', async (t) => {
  const cwd = tempDir(t);
  const gate = await runGate({
    cwd,
    config: {
      gate: {
        commands: ['node -e "process.stdout.write(\'x\'.repeat(5000))"'],
        autodetect: false,
      },
    },
    aggregate: aggregateWith(),
    log: collectLog(),
  });
  assert.equal(gate.checks[0].exit, 0);
  assert.equal(gate.checks[0].stdoutTail.length, 4000);
  assert.equal(gate.checks[0].stdoutTail, 'x'.repeat(4000));
});

test('gate: a timed-out command fails the gate', async (t) => {
  const cwd = tempDir(t);
  const gate = await runGate({
    cwd,
    config: {
      gate: {
        commands: ['node -e "setTimeout(() => {}, 1500)"'],
        autodetect: false,
        timeoutMs: 250,
      },
    },
    aggregate: aggregateWith(),
    log: collectLog(),
  });
  assert.equal(gate.checks[0].timedOut, true);
  assert.equal(gate.checks[0].exit === 0, false);
  assert.equal(gate.verdict, 'fail');
  assert.equal(gate.exitCode, 4);
});

test('gate: engine exception produces verdict=error / exitCode=5', async (t) => {
  const cwd = tempDir(t);
  const blocker = join(cwd, 'not-a-directory');
  writeFileSync(blocker, 'x', 'utf8');
  const gate = await runGate({
    cwd,
    config: { gate: { commands: [EXIT_0], autodetect: false } },
    aggregate: aggregateWith(),
    runDir: blocker,
    log: collectLog(),
  });
  assert.equal(gate.verdict, 'error');
  assert.equal(gate.exitCode, 5);
  assert.equal(typeof gate.error.message, 'string');
});

/* ------------------------------------------------------------------------- */
/* hooks                                                                     */
/* ------------------------------------------------------------------------- */

test('hooks: buildHookScript is POSIX sh and invokes bin/review.mjs', () => {
  const script = buildHookScript('pre-commit', '/opt/dsh-code-reviewer');
  const lines = script.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.ok(script.includes('command -v node >/dev/null 2>&1 || exit 0'));
  assert.ok(script.includes('ROOT="/opt/dsh-code-reviewer"'));
  assert.ok(script.includes('node "$ROOT/bin/review.mjs" hook pre-commit || exit $?'));
  assert.ok(!script.includes('\r'));
  assert.throws(() => buildHookScript('post-commit', '/tmp'), (err) => err.code === 'USAGE');
});

test('hooks: install / uninstall in a temp git repo', (t) => {
  const repo = initRepo(t);
  const log = collectLog();
  const installed = installHooks({ cwd: repo, log });
  assert.equal(installed.installed, true);
  assert.equal(installed.hooksPath, '.githooks');
  const hooksPath = gitOk(repo, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
  assert.equal(hooksPath, '.githooks');

  const toolRootPosix = REPO_ROOT.replace(/\\/g, '/');
  for (const name of ['pre-commit', 'pre-push']) {
    const file = join(repo, '.githooks', name);
    assert.ok(existsSync(file), `${name} must exist`);
    const content = readFileSync(file, 'utf8');
    assert.ok(content.startsWith('#!/bin/sh'));
    assert.ok(content.includes('bin/review.mjs'));
    assert.ok(content.includes(`hook ${name}`));
    assert.ok(content.includes(toolRootPosix), 'default ROOT must be the tool checkout');
    assert.ok(!content.includes('\r'), 'hooks must use LF');
  }

  const uninstalled = uninstallHooks({ cwd: repo, log });
  assert.equal(uninstalled.uninstalled, true);
  assert.equal(uninstalled.removed, true);
  const after = git(repo, ['config', '--local', '--get', 'core.hooksPath']);
  assert.notEqual(after.status, 0, 'core.hooksPath must be unset');
  assert.ok(existsSync(join(repo, '.githooks', 'pre-commit')), 'hook files are kept on uninstall');
});

test('hooks: install fails outside a git repository', (t) => {
  const dir = tempDir(t);
  assert.throws(() => installHooks({ cwd: dir }), (err) => err.code === 'GIT');
});

test('hooks: installed pre-commit hook blocks a real git commit (and passes when fixed)', (t) => {
  const repo = initRepo(t);
  // Fake tool root: the generated hook calls `node $ROOT/bin/review.mjs hook pre-commit`.
  // Exit code is driven by an env var so we can test both outcomes.
  const fakeRoot = tempDir(t, 'dcr-fake-tool-');
  mkdirSync(join(fakeRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(fakeRoot, 'bin', 'review.mjs'),
    '#!/usr/bin/env node\nprocess.exit(Number(process.env.FAKE_REVIEW_EXIT ?? "0"));\n',
    'utf8',
  );
  installHooks({ cwd: repo, root: fakeRoot, log: collectLog() });

  stageFile(repo, 'blocked.txt', 'this commit must be rejected\n');
  const before = gitOk(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const blocked = git(repo, ['commit', '-m', 'should be blocked'], { FAKE_REVIEW_EXIT: '1' });
  assert.notEqual(blocked.status, 0, `commit should fail\nstderr: ${blocked.stderr}`);
  assert.equal(gitOk(repo, ['rev-parse', 'HEAD']).stdout.trim(), before, 'HEAD must not move');

  const passed = git(repo, ['commit', '-m', 'should pass'], { FAKE_REVIEW_EXIT: '0' });
  assert.equal(passed.status, 0, `commit should succeed\nstdout: ${passed.stdout}\nstderr: ${passed.stderr}`);
  assert.notEqual(gitOk(repo, ['rev-parse', 'HEAD']).stdout.trim(), before, 'HEAD must move');
});

test('hooks: runHook fast pre-commit runs only configured gate commands and blocks', async (t) => {
  const repo = initRepo(t);
  // A passing autodetectable script must NOT be used for pre-commit (config says
  // "gate.commands，若为空则不跑"); the explicit failing command must block.
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }),
    'utf8',
  );
  stageFile(repo, 'change.txt', 'change\n');
  const log = collectLog();
  const failing = await runHook({
    name: 'pre-commit',
    cwd: repo,
    config: { hooks: { preCommit: 'fast' }, gate: { commands: [EXIT_1], autodetect: true } },
    log,
  });
  assert.equal(failing.mode, 'fast');
  assert.equal(failing.scope.mode, 'staged');
  assert.deepEqual(failing.scope.files, ['change.txt']);
  assert.equal(failing.gate.checks.length, 1, 'pre-commit must not autodetect commands');
  assert.equal(failing.exitCode, 4);
  assert.ok(log.lines.some((line) => /hook|gate/i.test(line)));

  const passing = await runHook({
    name: 'pre-commit',
    cwd: repo,
    config: { hooks: { preCommit: 'fast' }, gate: { commands: [EXIT_0], autodetect: true } },
    log,
  });
  assert.equal(passing.exitCode, 0);

  const skipped = await runHook({
    name: 'pre-commit',
    cwd: repo,
    config: { hooks: { preCommit: 'fast' }, gate: { commands: [EXIT_1], autodetect: false } },
    log,
    env: { ...process.env, REVIEW_SKIP_HOOKS: '1' },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.exitCode, 0);

  const off = await runHook({
    name: 'pre-commit',
    cwd: repo,
    config: { hooks: { preCommit: 'off' }, gate: { commands: [EXIT_1], autodetect: false } },
    log,
  });
  assert.equal(off.skipped, true);
  assert.equal(off.exitCode, 0);
});

test('hooks: pre-push resolves the push range (upstream fallback: main)', async (t) => {
  const repo = initRepo(t);
  gitOk(repo, ['checkout', '--quiet', '-b', 'feature']);
  stageFile(repo, 'feature.txt', 'feature work\n');
  gitOk(repo, ['commit', '--quiet', '-m', 'feature commit']);

  const result = await runHook({
    name: 'pre-push',
    cwd: repo,
    config: { hooks: { prePush: 'fast' }, gate: { commands: [EXIT_0], autodetect: false } },
    log: collectLog(),
  });
  assert.equal(result.mode, 'fast');
  assert.equal(result.scope.mode, 'range');
  assert.equal(result.scope.base, 'main');
  assert.ok(result.scope.files.includes('feature.txt'), `files: ${JSON.stringify(result.scope.files)}`);
  assert.equal(result.exitCode, 0);
});

test('hooks: runHook validates repo/name', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    () => runHook({ name: 'post-commit', cwd: dir, config: {}, log: collectLog() }),
    (err) => err.code === 'USAGE',
  );
  await assert.rejects(
    () => runHook({ name: 'pre-commit', cwd: dir, config: {}, log: collectLog() }),
    (err) => err.code === 'GIT',
  );
});
