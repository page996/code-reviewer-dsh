/**
 * lib/gate.mjs — CONTRACT §7: deterministic gate execution + verdict/exitCode.
 *
 * `runGate({ cwd, config, aggregate, runDir, log, spawn? })`
 *   -> { schemaVersion, checks, verdict, blocking, exitCode, gateFile }
 *   and writes `<runDir>/gate.json` (when runDir is provided).
 *
 * Verdict precedence (CONTRACT):
 *   required command failed -> fail / exit 4
 *   blocking findings       -> fail / exit 2
 *   needs-human             -> needs-human / exit 3
 *   otherwise               -> pass / 0
 *   engine exception        -> error / exit 5
 *
 * Commands run through `cmd /c` on win32 and `sh -c` elsewhere; stdout+stderr
 * are captured up to the last 4000 chars. Zero npm dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { blockingFindings } from './aggregate.mjs';

const DEFAULT_TIMEOUT_MS = 900000;
const STDOUT_TAIL_CHARS = 4000;
const CAPTURE_LIMIT = 16384;
const KILL_GRACE_MS = 750;
const EXIT_ENGINE_ERROR = 5;

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function makeLogger(log) {
  return (level, message, extra) => {
    if (typeof log !== 'function') return;
    try {
      log(level, message, extra);
    } catch {
      /* logging must never break the gate */
    }
  };
}

function resolveTimeout(config, item) {
  const perCommand = Number(item?.timeoutMs);
  if (Number.isFinite(perCommand) && perCommand > 0) return Math.floor(perCommand);
  const configured = Number(config?.gate?.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_TIMEOUT_MS;
}

/** Normalize `gate.commands` (strings or `{id, cmd, required?, timeoutMs?}`). */
export function normalizeConfiguredCommands(raw) {
  return asArray(raw)
    .map((item, index) => {
      if (typeof item === 'string') {
        const cmd = item.trim();
        return cmd ? { id: `check-${index + 1}`, cmd, required: true } : null;
      }
      if (item && typeof item === 'object') {
        const cmd = toText(item.cmd ?? item.command).trim();
        if (!cmd) return null;
        return {
          id: toText(item.id) || `check-${index + 1}`,
          cmd,
          required: item.required !== false,
          ...(item.skipped === true ? { skipped: true } : {}),
          ...(Number.isFinite(Number(item.timeoutMs)) ? { timeoutMs: Number(item.timeoutMs) } : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function looksLikePytestProject(workDir) {
  const pyproject = join(workDir, 'pyproject.toml');
  if (existsSync(pyproject)) {
    try {
      const text = readFileSync(pyproject, 'utf8');
      // `pytest` as a tool/dependency, or any pyproject at all (CONTRACT says
      // "pyproject.toml/pytest" — presence is enough to probe it).
      return /pytest|\[tool\.pytest/i.test(text) || text.trim() !== '';
    } catch {
      return true;
    }
  }
  for (const name of ['pytest.ini', 'tox.ini', 'setup.cfg']) {
    const file = join(workDir, name);
    if (!existsSync(file)) continue;
    try {
      if (/\[tool:pytest\]|\[pytest\]|pytest/i.test(readFileSync(file, 'utf8'))) return true;
    } catch {
      /* ignore unreadable config */
    }
  }
  return false;
}

function makefileTestCommand(workDir) {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const file = join(workDir, name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      if (/^test\s*:/m.test(text)) return 'make test';
    } catch {
      /* ignore */
    }
    return null;
  }
  return null;
}

/**
 * Autodetect deterministic gate commands.
 * @returns {Array<{id: string, cmd: string, required: boolean}>}
 */
export function detectGateCommands(cwd) {
  const workDir = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const commands = [];
  const seen = new Set();
  const add = (id, cmd) => {
    if (!cmd || seen.has(cmd)) return;
    seen.add(cmd);
    commands.push({ id, cmd, required: true });
  };

  // 1) package.json scripts: lint, typecheck, test (in this order).
  const packagePath = join(workDir, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
      for (const name of ['lint', 'typecheck', 'test']) {
        if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') {
          add(name, `npm run ${name}`);
        }
      }
    } catch {
      /* invalid package.json: nothing to detect */
    }
  }

  // 2) Python / pytest project.
  if (looksLikePytestProject(workDir)) add('pytest', 'pytest');

  // 3) Makefile `test` target.
  const makeTarget = makefileTestCommand(workDir);
  if (makeTarget) add('make-test', makeTarget);

  return commands;
}

/**
 * Execute one shell command and capture exit code / duration / stdout tail.
 */
function runCommand({ id, cmd, cwd, timeoutMs, spawnImpl, env, log }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const shell = process.platform === 'win32' ? ['cmd', '/c', cmd] : ['sh', '-c', cmd];
    let child;
    try {
      child = spawnImpl(shell[0], shell.slice(1), {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows: cmd /c must receive the command line verbatim. Without this,
        // Node re-quotes the argument and embedded quotes break commands such as
        // `node -e "process.exit(1)"` (silently non-blocking gate).
        ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      resolvePromise({
        id,
        cmd,
        exit: null,
        durationMs: Date.now() - startedAt,
        stdoutTail: '',
        timedOut: false,
        error: toText(err?.message ?? err),
      });
      return;
    }

    let tail = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let hardTimer = null;

    const append = (chunk) => {
      tail += toText(chunk);
      if (tail.length > CAPTURE_LIMIT) tail = tail.slice(-CAPTURE_LIMIT);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      // Release our pipe handles even when a killed child leaves grandchildren.
      try {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
      } catch {
        /* ignore */
      }
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log?.('warn', `gate: ${id} 超时（${timeoutMs}ms），终止进程`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
        } catch {
          /* ignore */
        }
      }, Math.min(200, KILL_GRACE_MS));
      // If the OS never reports 'exit' (e.g. killed wrapper on Windows), settle
      // anyway so the gate cannot hang the caller (300s default would be awful).
      hardTimer = setTimeout(() => {
        settle({
          id,
          cmd,
          exit: null,
          durationMs: Date.now() - startedAt,
          stdoutTail: tail.slice(-STDOUT_TAIL_CHARS),
          timedOut: true,
          error: 'timeout',
        });
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      settle({
        id,
        cmd,
        exit: null,
        durationMs: Date.now() - startedAt,
        stdoutTail: tail.slice(-STDOUT_TAIL_CHARS),
        timedOut,
        error: toText(err?.message ?? err),
      });
    });
    child.on('exit', (code, signal) => {
      settle({
        id,
        cmd,
        exit: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        stdoutTail: tail.slice(-STDOUT_TAIL_CHARS),
        timedOut,
        ...(typeof code === 'number' ? {} : { error: 'terminated-without-exit-code' }),
      });
    });
  });
}

function writeGateJson(runDir, gate) {
  if (typeof runDir !== 'string' || runDir.trim() === '') return null;
  const directory = isAbsolute(runDir) ? runDir : resolve(runDir);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'gate.json');
  writeFileSync(file, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  return file;
}

/* ------------------------------------------------------------------------- */
/* public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {{cwd?: string, config?: object, aggregate?: object, runDir?: string,
 *          log?: Function, spawn?: Function}} args
 */
export async function runGate({ cwd, config, aggregate, runDir, log, spawn, scopeMode } = {}) {
  const logger = makeLogger(log);
  const workDir = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const spawnImpl = typeof spawn === 'function' ? spawn : nodeSpawn;
  const gateConfig = config?.gate && typeof config.gate === 'object' ? config.gate : {};
  const aggregateData = aggregate && typeof aggregate === 'object' ? aggregate : {};

  try {
    const configured = normalizeConfiguredCommands(gateConfig.commands);
    const autodetect = gateConfig.autodetect !== false;
    const commands =
      configured.length > 0
        ? configured.map((item) => ({ ...item }))
        : autodetect
          ? detectGateCommands(workDir)
          : [];

    if (commands.length === 0) {
      logger('info', 'gate: 没有配置/探测到门禁命令，跳过命令检查');
    }

    const checks = [];
    for (const item of commands) {
      if (item.skipped) {
        checks.push({
          id: item.id,
          cmd: item.cmd,
          exit: 0,
          durationMs: 0,
          stdoutTail: '',
          required: item.required !== false,
          skipped: true,
        });
        continue;
      }
      const timeoutMs = resolveTimeout(config, item);
      logger('info', `gate: 执行 ${item.id}: ${item.cmd}（timeout ${timeoutMs}ms）`);
      const result = await runCommand({
        id: item.id,
        cmd: item.cmd,
        cwd: workDir,
        timeoutMs,
        spawnImpl,
        env: process.env,
        log: logger,
      });
      const check = {
        id: item.id,
        cmd: item.cmd,
        exit: result.exit,
        durationMs: result.durationMs,
        stdoutTail: result.stdoutTail,
        required: item.required !== false,
        skipped: false,
      };
      if (result.timedOut) check.timedOut = true;
      if (result.signal) check.signal = result.signal;
      if (result.error) check.error = result.error;
      checks.push(check);
      logger(
        result.exit === 0 && !result.timedOut ? 'info' : 'warn',
        `gate: ${item.id} exit=${result.exit}${result.timedOut ? ' (timeout)' : ''} (${result.durationMs}ms)`,
      );
    }

    // A scan has no diff: every finding describes existing code and must not block a
    // change gate. `gate.blockPreexisting=true` opts into blocking them anyway.
    const scanFindingsOnly =
      scopeMode === 'scan' && config?.gate?.blockPreexisting !== true;
    const blocking = scanFindingsOnly ? [] : blockingFindings(aggregateData, config);
    const counts = aggregateData.counts ?? {};
    // In scan mode findings are advisory: only reviewer failures (an incomplete review)
    // keep the needs-human exit; in diff mode needs-human *findings* also gate.
    const needsHumanSignal =
      asArray(aggregateData.errors).length > 0 ||
      (!scanFindingsOnly &&
        (Number(counts.needsHuman) > 0 ||
          asArray(aggregateData.findings).some((finding) => finding?.status === 'needs-human')));

    const failedChecks = checks.filter(
      (check) => !check.skipped && check.required !== false && (check.exit === null || check.exit !== 0),
    );

    let verdict = 'pass';
    let exitCode = 0;
    if (failedChecks.length > 0) {
      verdict = 'fail';
      exitCode = 4;
    } else if (blocking.length > 0) {
      verdict = 'fail';
      exitCode = 2;
    } else if (needsHumanSignal) {
      verdict = 'needs-human';
      exitCode = 3;
    }

    const gate = {
      schemaVersion: 1,
      checks,
      verdict,
      blocking,
      exitCode,
    };

    let gateFile = null;
    try {
      gateFile = writeGateJson(runDir, gate);
    } catch (err) {
      throw makeError('GATE', `写入 gate.json 失败: ${toText(err?.message ?? err)}`);
    }
    if (gateFile) gate.gateFile = gateFile;
    logger('info', `gate: verdict=${verdict} exitCode=${exitCode}`);
    return gate;
  } catch (err) {
    const message = toText(err?.message ?? err);
    logger('error', `gate: 引擎异常: ${message}`);
    const engineGate = {
      schemaVersion: 1,
      checks: [],
      verdict: 'error',
      blocking: [],
      exitCode: EXIT_ENGINE_ERROR,
      error: { code: typeof err?.code === 'string' ? err.code : 'GATE', message },
    };
    try {
      const gateFile = writeGateJson(runDir, engineGate);
      if (gateFile) engineGate.gateFile = gateFile;
    } catch {
      /* best effort only */
    }
    return engineGate;
  }
}

export default runGate;
