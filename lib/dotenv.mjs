/**
 * Minimal `.env` reader (zero dependencies).
 *
 * Scope: the tiny subset this tool needs. `KEY=VALUE`, optional `export ` prefix,
 * `#` comments, blank lines, single/double quoted values, backslash escapes inside
 * double quotes, and unquoted trailing comments preceded by whitespace.
 *
 * Precedence used by resolveEnv(): real environment > <cwd>/.env > $DSH_HOME/.env.
 *
 * Values are returned as strings. Nothing ever logs a value: callers own the
 * responsibility of keeping secrets out of outputs (see CONTRACT §1/§2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DSH_HOME_ENV = 'DSH_HOME';
export const DOTENV_FILE_NAME = '.env';

const KEY_RE = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(.*)$/;

/**
 * Parse the text of one .env file.
 * @param {string} content
 * @returns {Map<string,string>}
 */
export function parseDotEnv(content) {
  const out = new Map();
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = KEY_RE.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    out.set(key, parseValue(rest));
  }
  return out;
}

function parseValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const quote = text[0];
  if (quote === "'") {
    const end = text.indexOf("'", 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  if (quote === '"') {
    let value = '';
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"') return value;
      if (ch !== '\\') {
        value += ch;
        continue;
      }
      const next = text[i + 1];
      if (next === undefined) {
        value += '\\';
        break;
      }
      i += 1;
      switch (next) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case '\\':
          value += '\\';
          break;
        case '"':
          value += '"';
          break;
        case '$':
          value += '$';
          break;
        default:
          value += `\\${next}`;
      }
    }
    return value;
  }

  // Unquoted: drop a trailing ` # comment` (whitespace required before `#`).
  const commentAt = text.search(/[ \t]#/);
  const value = commentAt === -1 ? text : text.slice(0, commentAt);
  return value.trim();
}

/**
 * Read and merge a list of .env files. Later paths win. Missing/unreadable files
 * are skipped silently (the environment is optional by design).
 * @param {string[]} paths
 * @returns {Map<string,string>}
 */
export function readDotEnv(paths = []) {
  const merged = new Map();
  const list = Array.isArray(paths) ? paths : [paths];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p !== 'string') continue;
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of parseDotEnv(text)) merged.set(key, value);
  }
  return merged;
}

/** Candidate .env files, in ascending precedence order (home first, cwd last). */
export function dotEnvPaths({ cwd, home } = {}) {
  const resolvedHome = home || os.homedir();
  const paths = [];
  if (resolvedHome) paths.push(path.join(resolvedHome, DOTENV_FILE_NAME));
  if (cwd) paths.push(path.join(path.resolve(cwd), DOTENV_FILE_NAME));
  return paths;
}

/**
 * Merge process env + <cwd>/.env + $DSH_HOME/.env.
 * Precedence: env (highest) > cwd/.env > $DSH_HOME/.env (lowest).
 * @param {{cwd?: string, home?: string, env?: Record<string, unknown>}} [options]
 * @returns {Record<string,string>}
 */
export function resolveEnv({ cwd, home, env } = {}) {
  const ambient = env ?? process.env ?? {};
  const resolvedHome = home || ambient[DSH_HOME_ENV] || os.homedir();
  const cwdDir = cwd || process.cwd();

  const merged = new Map();
  for (const [key, value] of readDotEnv(dotEnvPaths({ cwd: cwdDir, home: resolvedHome }))) {
    merged.set(key, value);
  }

  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined || value === null) continue;
    merged.set(key, String(value));
  }

  const out = {};
  for (const [key, value] of merged) out[key] = value;
  return out;
}
