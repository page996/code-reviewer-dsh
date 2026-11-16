/**
 * Config loading/merging — CONTRACT §2.
 *
 * Merge order (lowest -> highest):
 *   DEFAULTS <- $DSH_HOME/.dsh-code-review.json (optional)
 *            <- <repo>/.review/config.json (optional, or --config <file>)
 *            <- CLI overrides
 *
 * Unknown fields are preserved and never raise. Invalid values for *known*
 * fields raise an Error with code CONFIG. The API key is never read here: we
 * keep the env var NAME (model.apiKeyEnv) and resolve only the public base URL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveEnv, DSH_HOME_ENV } from './dotenv.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
export const GLOBAL_CONFIG_NAME = '.dsh-code-review.json';
export const REPO_CONFIG_PATH = '.review/config.json';

export const LENSES = Object.freeze([
  'intent',
  'correctness',
  'errors',
  'concurrency',
  'data',
  'security',
  'contract',
  'tests',
  'scope',
  'history',
]);

export const EFFORTS = Object.freeze(['quick', 'standard', 'deep']);
export const TRANSPORTS = Object.freeze(['anthropic', 'openai']);
export const GROUP_BY = Object.freeze(['auto', 'perfile', 'none']);
export const HOOK_MODES = Object.freeze(['off', 'fast', 'full']);
export const SEVERITIES = Object.freeze(['blocker', 'major', 'minor']);
export const REPORT_FORMATS = Object.freeze(['md', 'json', 'sarif']);
export const REASONING_EFFORTS = Object.freeze(['off', 'low', 'medium', 'high', 'max']);

/** Canonical defaults — CONTRACT §2 (deep-frozen; loadConfig never mutates it). */
export const DEFAULTS = deepFreeze({
  schemaVersion: 1,
  model: {
    transport: 'anthropic',
    baseUrl: null,
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    maxTokens: null,
  },
  scope: {
    include: [],
    exclude: [],
    maxFileBytes: 1048576,
    skipGlobs: ['**/*.lock', '**/dist/**', '**/node_modules/**', '**/.git/**'],
    secretGlobs: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.npmrc'],
  },
  plan: { maxFilesPerUnit: 10, maxLinesPerUnit: 400, groupBy: 'auto' },
  review: {
    effort: 'standard',
    lenses: null,
    maxComments: 30,
    votesForMajor: 2,
    rounds: 1,
    concurrency: 4,
    filter: true,
    contractFile: null,
  },
  rules: { builtin: true, paths: ['.review/rules'], maxCharsPerFile: 20000 },
  gate: {
    commands: [],
    autodetect: true,
    blockOn: ['blocker', 'major'],
    blockPreexisting: false,
    timeoutMs: 900000,
  },
  hooks: { preCommit: 'fast', prePush: 'fast', enabled: true },
  report: { formats: ['md', 'json', 'sarif'], outDir: '.review/runs' },
});

/** Build an Error carrying the contract error code. */
export function configError(message, cause) {
  const err = new Error(message);
  err.code = 'CONFIG';
  if (cause) err.cause = cause;
  return err;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Deep merge. Plain objects merge recursively; arrays and scalars replace.
 * `undefined` leaves the base value in place; `null` is an explicit value.
 */
export function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return override === undefined ? cloneValue(base) : cloneValue(override);
  }
  const out = {};
  for (const [key, value] of Object.entries(base)) out[key] = cloneValue(value);
  if (!isPlainObject(override)) {
    return override === undefined ? out : cloneValue(override);
  }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : cloneValue(value);
  }
  return out;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = cloneValue(inner);
    return out;
  }
  return value;
}

function readJsonFile(file, { required = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (!required && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR')) return null;
    if (err.code === 'ENOENT') throw configError(`config file not found: ${file}`, err);
    throw configError(`cannot read config file ${file}: ${err.message}`, err);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw configError(`invalid JSON in config file ${file}: ${err.message}`, err);
  }
  if (data === null) return {};
  if (!isPlainObject(data)) throw configError(`config file ${file} must contain a JSON object`);
  return data;
}

function homeDirFor({ home, env }) {
  if (home) return path.resolve(home);
  const dshHome = env?.[DSH_HOME_ENV];
  return dshHome ? path.resolve(String(dshHome)) : os.homedir();
}

/**
 * Load the effective config.
 * @param {{cwd?: string, configPath?: string, overrides?: object, home?: string,
 *          env?: Record<string,string>, log?: Function}} [options]
 * @returns {object} effective config (deep clone; safe to mutate)
 */
export function loadConfig({ cwd, configPath, overrides, home, env, log } = {}) {
  const baseDir = path.resolve(cwd || process.cwd());
  const envMap = env ?? resolveEnv({ cwd: baseDir });

  const globalFile = path.join(homeDirFor({ home, env: envMap }), GLOBAL_CONFIG_NAME);
  const globalConfig = readJsonFile(globalFile, { required: false });

  let repoFile;
  let repoRequired = false;
  if (configPath) {
    repoFile = path.resolve(baseDir, configPath);
    repoRequired = true;
  } else {
    repoFile = path.join(baseDir, REPO_CONFIG_PATH);
  }
  const repoConfig = readJsonFile(repoFile, { required: repoRequired });

  let merged = deepMerge(DEFAULTS, globalConfig ?? {});
  merged = deepMerge(merged, repoConfig ?? {});
  if (overrides !== undefined && overrides !== null) {
    if (!isPlainObject(overrides)) throw configError('config overrides must be a plain object');
    merged = deepMerge(merged, overrides);
  }

  validateConfig(merged);

  merged.model.baseUrl = resolveBaseUrl(merged.model, envMap);
  if (log) {
    log('debug', 'config loaded', { repoConfig: repoFile, globalConfig: globalFile });
  }
  return merged;
}

/**
 * Resolve the public base URL: explicit config value, else env, else the Anthropic default.
 * Never reads the API key.
 */
export function resolveBaseUrl(model, env = {}) {
  const explicit = model?.baseUrl;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const envName = typeof model?.baseUrlEnv === 'string' && model.baseUrlEnv.trim() ? model.baseUrlEnv.trim() : 'DEEPSEEK_BASE_URL';
  const fromEnv = env?.[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_BASE_URL;
}

/** Return the name of the API-key env var (never its value). */
export function apiKeyEnvName(config) {
  const name = config?.model?.apiKeyEnv;
  return typeof name === 'string' && name.trim() ? name.trim() : 'DEEPSEEK_API_KEY';
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validateConfig(config) {
  if (!isPlainObject(config)) throw configError('config must be an object');

  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw configError(`unsupported config.schemaVersion: ${JSON.stringify(config.schemaVersion)} (expected 1)`);
  }

  if (!isPlainObject(config.model)) throw configError('config.model must be an object');
  const model = config.model;
  enumField(model, 'transport', TRANSPORTS, 'model.transport');
  enumField(model, 'reasoningEffort', REASONING_EFFORTS, 'model.reasoningEffort');
  stringField(model, 'model', 'model.model', { allowEmpty: false });
  stringField(model, 'apiKeyEnv', 'model.apiKeyEnv', { allowEmpty: false });
  stringField(model, 'baseUrlEnv', 'model.baseUrlEnv', { allowEmpty: false });
  nullableStringField(model, 'baseUrl', 'model.baseUrl');
  nullablePositiveInt(model, 'maxTokens', 'model.maxTokens');

  if (!isPlainObject(config.scope)) throw configError('config.scope must be an object');
  const scope = config.scope;
  stringArrayField(scope, 'include', 'scope.include');
  stringArrayField(scope, 'exclude', 'scope.exclude');
  stringArrayField(scope, 'skipGlobs', 'scope.skipGlobs');
  stringArrayField(scope, 'secretGlobs', 'scope.secretGlobs');
  positiveInt(scope, 'maxFileBytes', 'scope.maxFileBytes');

  if (!isPlainObject(config.plan)) throw configError('config.plan must be an object');
  positiveInt(config.plan, 'maxFilesPerUnit', 'plan.maxFilesPerUnit');
  positiveInt(config.plan, 'maxLinesPerUnit', 'plan.maxLinesPerUnit');
  enumField(config.plan, 'groupBy', GROUP_BY, 'plan.groupBy');

  if (!isPlainObject(config.review)) throw configError('config.review must be an object');
  enumField(config.review, 'effort', EFFORTS, 'review.effort');
  nullableStringArrayField(config.review, 'lenses', 'review.lenses');
  if (Array.isArray(config.review.lenses)) {
    for (const lens of config.review.lenses) {
      if (!LENSES.includes(lens)) throw configError(`invalid review.lenses entry: ${JSON.stringify(lens)}`);
    }
  }
  nonNegativeInt(config.review, 'maxComments', 'review.maxComments');
  positiveInt(config.review, 'votesForMajor', 'review.votesForMajor');
  positiveInt(config.review, 'rounds', 'review.rounds');
  positiveInt(config.review, 'concurrency', 'review.concurrency');
  booleanField(config.review, 'filter', 'review.filter');
  nullableStringField(config.review, 'contractFile', 'review.contractFile');

  if (!isPlainObject(config.rules)) throw configError('config.rules must be an object');
  booleanField(config.rules, 'builtin', 'rules.builtin');
  stringArrayField(config.rules, 'paths', 'rules.paths');
  positiveInt(config.rules, 'maxCharsPerFile', 'rules.maxCharsPerFile');

  if (!isPlainObject(config.gate)) throw configError('config.gate must be an object');
  if (!Array.isArray(config.gate.commands)) throw configError('config.gate.commands must be an array');
  for (const cmd of config.gate.commands) {
    if (typeof cmd === 'string') continue;
    if (isPlainObject(cmd) && typeof cmd.cmd === 'string') continue;
    throw configError('config.gate.commands entries must be strings or objects with a string `cmd`');
  }
  booleanField(config.gate, 'autodetect', 'gate.autodetect');
  if (!Array.isArray(config.gate.blockOn)) throw configError('config.gate.blockOn must be an array');
  for (const sev of config.gate.blockOn) {
    if (!SEVERITIES.includes(sev)) throw configError(`invalid config.gate.blockOn entry: ${JSON.stringify(sev)}`);
  }
  booleanField(config.gate, 'blockPreexisting', 'gate.blockPreexisting');
  positiveInt(config.gate, 'timeoutMs', 'gate.timeoutMs');

  if (!isPlainObject(config.hooks)) throw configError('config.hooks must be an object');
  enumField(config.hooks, 'preCommit', HOOK_MODES, 'hooks.preCommit');
  enumField(config.hooks, 'prePush', HOOK_MODES, 'hooks.prePush');
  booleanField(config.hooks, 'enabled', 'hooks.enabled');

  if (!isPlainObject(config.report)) throw configError('config.report must be an object');
  if (!Array.isArray(config.report.formats) || config.report.formats.length === 0) {
    throw configError('config.report.formats must be a non-empty array');
  }
  for (const fmt of config.report.formats) {
    if (!REPORT_FORMATS.includes(fmt)) throw configError(`invalid config.report.formats entry: ${JSON.stringify(fmt)}`);
  }
  stringField(config.report, 'outDir', 'report.outDir', { allowEmpty: false });
}

function failField(fieldPath, detail) {
  return configError(`invalid ${fieldPath}: ${detail}`);
}

function enumField(obj, key, allowed, fieldPath) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (!allowed.includes(value)) throw failField(fieldPath, `${JSON.stringify(value)} (expected one of ${allowed.join('|')})`);
}

function stringField(obj, key, fieldPath, { allowEmpty = true } = {}) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (typeof value !== 'string') throw failField(fieldPath, `expected a string, got ${typeof value}`);
  if (!allowEmpty && !value.trim()) throw failField(fieldPath, 'must not be empty');
}

function nullableStringField(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw failField(fieldPath, `expected a string or null, got ${typeof value}`);
}

function booleanField(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw failField(fieldPath, `expected a boolean, got ${typeof value}`);
}

function positiveInt(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) throw failField(fieldPath, `expected an integer >= 1, got ${JSON.stringify(value)}`);
}

function nonNegativeInt(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) throw failField(fieldPath, `expected an integer >= 0, got ${JSON.stringify(value)}`);
}

function nullablePositiveInt(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 1) throw failField(fieldPath, `expected a positive integer or null, got ${JSON.stringify(value)}`);
}

function stringArrayField(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) throw failField(fieldPath, 'expected an array of strings');
  for (const item of value) {
    if (typeof item !== 'string') throw failField(fieldPath, `expected an array of strings, got entry ${JSON.stringify(item)}`);
  }
}

function nullableStringArrayField(obj, key, fieldPath) {
  const value = obj?.[key];
  if (value === undefined || value === null) return;
  stringArrayField(obj, key, fieldPath);
}
