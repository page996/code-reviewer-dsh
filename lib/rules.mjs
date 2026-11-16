/**
 * Rule packs: frontmatter parsing, glob matching, loading (builtin + project),
 * and per-file rule resolution with a character budget. CONTRACT §4.
 *
 * Rule file format (rules/*.md):
 *   ---
 *   id: core-security
 *   title: 安全与信任边界
 *   paths: ["**\/*.js", "**\/*.ts"]
 *   severityHint: blocker
 *   alwaysApply: false
 *   ---
 *   body (markdown, checked by the reviewer model)
 *
 * The frontmatter parser intentionally implements only a tiny YAML subset:
 * scalars, booleans, numbers, inline arrays `[a, b]`, block arrays (`- item`),
 * single/double quoted strings, and `#` comments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, configError } from './config.mjs';

const DEFAULT_BUILTIN_DIR = fileURLToPath(new URL('../rules/', import.meta.url));
const SEVERITY_HINTS = new Set(['blocker', 'major', 'minor']);

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function escapeRegExpChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a glob into a regular-expression source fragment.
 * Supported: `**` (any chars, including `/`), `*` (any chars except `/`),
 * `?` (one char except `/`), `{a,b}` alternation, `[abc]` / `[!abc]` classes.
 */
function globToRegExpSource(pattern) {
  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '\\') {
      if (i + 1 < n) {
        out += escapeRegExpChar(pattern[i + 1]);
        i += 2;
      } else {
        out += '\\\\';
        i += 1;
      }
      continue;
    }
    if (ch === '*') {
      let stars = 0;
      while (i < n && pattern[i] === '*') {
        stars += 1;
        i += 1;
      }
      if (stars >= 2) {
        if (pattern[i] === '/') {
          out += '(?:.*/)?';
          i += 1;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alternatives = inner.split(',');
      if (alternatives.length < 2) {
        out += `(?:${globToRegExpSource(inner)})`;
      } else {
        out += `(?:${alternatives.map((alt) => globToRegExpSource(alt)).join('|')})`;
      }
      i = close + 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let inner = pattern.slice(i + 1, close);
      let negated = false;
      if (inner.startsWith('!') || inner.startsWith('^')) {
        negated = true;
        inner = inner.slice(1);
      }
      inner = inner.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
      if (inner.includes('/')) inner = inner.replace(/\//g, '');
      if (!inner) {
        out += '\\[';
        i += 1;
        continue;
      }
      // Never let a class match the path separator.
      out += negated ? `[^${inner}/]` : `[${inner}]`;
      i = close + 1;
      continue;
    }
    out += escapeRegExpChar(ch);
    i += 1;
  }
  return out;
}

const GLOB_CACHE = new Map();
function compileGlob(pattern) {
  let compiled = GLOB_CACHE.get(pattern);
  if (compiled) return compiled;
  const source = globToRegExpSource(pattern);
  compiled = {
    full: new RegExp(`^(?:${source})$`),
    anchoredPrefix: new RegExp(`^(?:${source})(?:/.*)?$`),
    anySegment: new RegExp(`(?:^|/)(?:${source})(?:/|$)`),
  };
  GLOB_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * Match a repository-relative POSIX path against a glob pattern.
 * - `path` may use forward or back slashes; a leading `./` is ignored.
 * - A pattern containing no `/` also matches the basename at any depth.
 * - A trailing `/` means "this directory or anything under it".
 * @param {string} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
export function matchGlob(pattern, filePath) {
  if (typeof pattern !== 'string' || typeof filePath !== 'string') return false;
  let pat = pattern.trim().replace(/\\/g, '/');
  if (!pat) return false;
  while (pat.startsWith('./')) pat = pat.slice(2);
  let target = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) return false;
  while (target.startsWith('./')) target = target.slice(2);

  const dirOnly = pat.endsWith('/');
  pat = pat.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!pat) return dirOnly ? target.length > 0 : false;

  const compiled = compileGlob(pat);
  if (dirOnly) {
    if (compiled.anchoredPrefix.test(target)) return true;
    if (!pat.includes('/') && compiled.anySegment.test(target)) return true;
    return false;
  }
  if (compiled.full.test(target)) return true;
  if (!pat.includes('/')) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return compiled.full.test(base);
  }
  return false;
}

/** True when any pattern matches the path. */
export function matchAnyGlob(patterns, filePath) {
  if (!Array.isArray(patterns)) return false;
  for (const pattern of patterns) {
    if (matchGlob(pattern, filePath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// tiny YAML subset parser
// ---------------------------------------------------------------------------

function stripInlineComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function parseScalar(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  text = stripInlineComment(text).trim();
  if (!text) return '';
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (text === 'null' || text === 'Null' || text === 'NULL' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

function splitInlineList(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current);
  return items.map((item) => parseScalar(item));
}

/**
 * Parse the tiny YAML subset used by rule frontmatter.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseYamlSubset(text) {
  const data = {};
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent > 0) {
      // A stray indented line with no owning key: ignore it.
      i += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(trimmed);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1];
    const restRaw = match[2];
    const rest = stripInlineComment(restRaw).trim();

    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = splitInlineList(rest.slice(1, -1));
      i += 1;
      continue;
    }
    if (rest !== '') {
      data[key] = parseScalar(restRaw);
      i += 1;
      continue;
    }

    // Block sequence: subsequent lines starting with "- ".
    const items = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        j += 1;
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent === 0) break;
      if (!trimmedLine.startsWith('-')) break;
      const itemText = trimmedLine.slice(1).trim();
      items.push(parseScalar(itemText));
      j += 1;
    }
    data[key] = items.length > 0 ? items : null;
    i = items.length > 0 ? j : i + 1;
  }
  return data;
}

/**
 * Split a markdown file into frontmatter data and body.
 * @param {string} text
 * @returns {{data: Record<string, unknown>, body: string, hasFrontmatter: boolean}}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    return { data: {}, body: source, hasFrontmatter: false };
  }
  return {
    data: parseYamlSubset(match[1]),
    body: source.slice(match[0].length),
    hasFrontmatter: true,
  };
}

// ---------------------------------------------------------------------------
// loading / resolving
// ---------------------------------------------------------------------------

function readRuleFile(file, { source, baseDir }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw configError(`cannot read rule file ${file}: ${err.message}`, err);
  }
  const baseName = path.basename(file).replace(/\.md$/i, '');
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : baseName;
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id;
  let paths = [];
  if (Array.isArray(data.paths)) paths = data.paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  else if (typeof data.paths === 'string' && data.paths.trim()) paths = [data.paths.trim()];
  const severityHint = typeof data.severityHint === 'string' && SEVERITY_HINTS.has(data.severityHint) ? data.severityHint : null;
  const alwaysApply = data.alwaysApply === true || data.alwaysApply === 'true';
  const relFile = path.relative(baseDir, file);
  const shownFile = relFile && !relFile.startsWith('..') && !path.isAbsolute(relFile) ? toPosix(relFile) : toPosix(file);
  return {
    id,
    title,
    source,
    paths,
    severityHint,
    alwaysApply,
    body: String(body ?? '').trim(),
    file: shownFile,
    hasFrontmatter,
  };
}

function readRuleDir(dir, source, { baseDir, rules, log } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') {
      if (log) log('debug', `rule dir not found (skipped): ${dir}`);
      return;
    }
    throw configError(`cannot read rules directory ${dir}: ${err.message}`, err);
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of files) {
    const rule = readRuleFile(file, { source, baseDir });
    rules.set(rule.id, rule);
  }
}

function normalizedRulesConfig(config) {
  const fromConfig = config?.rules ?? {};
  const out = { ...DEFAULTS.rules, ...fromConfig };
  return {
    builtin: out.builtin !== false,
    paths: Array.isArray(out.paths) ? out.paths.filter((p) => typeof p === 'string' && p.trim()) : DEFAULTS.rules.paths,
    maxCharsPerFile: Number.isInteger(out.maxCharsPerFile) && out.maxCharsPerFile > 0 ? out.maxCharsPerFile : DEFAULTS.rules.maxCharsPerFile,
  };
}

/**
 * Load builtin rule packs plus project rule packs.
 * Project rules override builtin rules with the same id.
 * @param {{cwd?: string, config?: object, builtinDir?: string, log?: Function}} [options]
 * @returns {Array<object>} rules sorted by id
 */
export function loadRules({ cwd, config, builtinDir, log } = {}) {
  const baseDir = path.resolve(cwd || process.cwd());
  const rulesCfg = normalizedRulesConfig(config);
  const rules = new Map();

  if (rulesCfg.builtin) {
    const dir = path.resolve(builtinDir || DEFAULT_BUILTIN_DIR);
    readRuleDir(dir, 'builtin', { baseDir, rules, log });
  }
  for (const rel of rulesCfg.paths) {
    const dir = path.isAbsolute(rel) ? rel : path.resolve(baseDir, rel);
    readRuleDir(dir, 'project', { baseDir, rules, log });
  }

  return Array.from(rules.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when a rule applies to the given repo-relative POSIX file path. */
export function ruleMatchesFile(rule, filePath) {
  if (!rule) return false;
  if (rule.alwaysApply) return true;
  const paths = Array.isArray(rule.paths) ? rule.paths : [];
  if (paths.length === 0) return false;
  return matchAnyGlob(paths, filePath);
}

/**
 * Resolve the rules that apply to one file, honoring a total body-character budget.
 * The first applicable rule is always included (truncated if it alone exceeds the
 * budget) so a single oversized pack cannot silently disable review context.
 * @param {{path: string, rules: Array<object>, maxChars?: number}} args
 * @returns {Array<object>} rules with {body, truncated}
 */
export function resolveRulesForFile({ path: filePath, rules, maxChars } = {}) {
  const budgetTotal =
    Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : Number.isInteger(DEFAULTS.rules.maxCharsPerFile)
        ? DEFAULTS.rules.maxCharsPerFile
        : 20000;
  if (budgetTotal <= 0) return [];
  const list = Array.isArray(rules) ? rules : [];
  let budget = budgetTotal;
  const out = [];
  for (const rule of list) {
    if (!ruleMatchesFile(rule, filePath)) continue;
    const body = String(rule.body ?? '');
    if (out.length > 0 && budget <= 0) break;
    if (body.length <= budget) {
      out.push({ ...rule, body, truncated: false });
      budget -= body.length;
      continue;
    }
    const keep = Math.max(0, budget);
    const truncatedBody = keep > 0 ? `${body.slice(0, keep)}\n…` : '';
    out.push({ ...rule, body: truncatedBody, truncated: true });
    budget = 0;
  }
  return out;
}
