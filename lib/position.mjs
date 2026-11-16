/**
 * lib/position.mjs — CONTRACT §6: turn reviewer snippets/line numbers into
 * real new-file line ranges (`startLine`/`endLine`).
 *
 * `parsePatchNewLines(patch)` is OWNED BY `lib/git.mjs`. Because modules are
 * implemented in parallel, this module imports it lazily (top-level dynamic
 * import) and accepts several plausible return shapes. If `git.mjs` is not
 * available yet — or returns nothing for a non-empty patch — a small local
 * unified-diff parser is used so positioning never hard-depends on load order.
 * When `git.mjs` lands, its parser wins automatically.
 *
 * Anchor algorithm (CONTRACT):
 *   1. `existing_code` given  -> sliding window over the file's new content
 *      (exact match first, then whitespace-normalized; ±40 lines around `line`
 *      when a hint is present).
 *   2. otherwise / no match   -> clamp `line` to the set of new lines in the diff.
 *   3. no line either         -> fall back to the hunk range.
 *   4. still nothing          -> `anchored=false` + `anchorReason`.
 *   5. file not in unit       -> `anchored=false`, `anchorReason="out-of-scope"`.
 */

let gitParsePatchNewLines = null;
try {
  const gitModule = await import('./git.mjs');
  if (typeof gitModule.parsePatchNewLines === 'function') {
    gitParsePatchNewLines = gitModule.parsePatchNewLines;
  }
} catch {
  // lib/git.mjs not available yet (parallel implementation); fallback below.
}

const WINDOW_LINES = 40;

function toLine(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function normalizePath(value) {
  return toText(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function splitLines(text) {
  return toText(text).split(/\r?\n/);
}

function trimSnippetLines(snippet) {
  const lines = splitLines(snippet);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines;
}

function normalizeLineText(line) {
  return String(line ?? '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------------- */
/* patch -> new-line map (fallback / normalizer)                             */
/* ------------------------------------------------------------------------- */

/**
 * Minimal unified-diff parser: returns Map<newLineNumber, lineText>.
 * Only used as a fallback when `lib/git.mjs` provides no result.
 */
export function fallbackParsePatchNewLines(patch) {
  const lines = new Map();
  const text = toText(patch);
  if (!text) return lines;
  let newLine = 0;
  let inHunk = false;
  for (const raw of text.split(/\r?\n/)) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.set(newLine, raw.slice(1));
      newLine += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      lines.set(newLine, raw.slice(1));
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    if (raw === '') {
      // Trailing split artifact only; genuine empty context lines start with ' '.
      continue;
    }
    inHunk = false;
  }
  return lines;
}

function emptyNormalized() {
  return { lines: new Map(), ranges: [] };
}

function pushLine(map, lineNumber, text) {
  const n = toLine(lineNumber);
  if (n === null) return;
  map.set(n, typeof text === 'string' ? text : map.get(n) ?? null);
}

/**
 * Accept the plausible shapes `parsePatchNewLines` may return and normalize to
 * `{ lines: Map<number,string|null>, ranges: [{start,end}] }`.
 */
export function normalizeNewLineInfo(raw) {
  const result = emptyNormalized();
  const map = result.lines;

  const addRange = (startValue, endValue) => {
    const start = toLine(startValue);
    if (start === null) return;
    const end = Math.max(start, toLine(endValue) ?? start);
    result.ranges.push({ start, end });
    for (let n = start; n <= end; n += 1) {
      if (!map.has(n)) map.set(n, null);
    }
  };

  const visitObject = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj instanceof Map) {
      for (const [key, value] of obj.entries()) pushLine(map, key, typeof value === 'string' ? value : null);
      return;
    }
    if (obj instanceof Set) {
      for (const value of obj.values()) pushLine(map, value, null);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) visitObject(item);
      return;
    }
    // Unified-diff hunks: `{header: "@@ -a,b +c,d @@", lines: [...]}` (lib/git.mjs).
    if (Array.isArray(obj.hunks)) {
      for (const hunk of obj.hunks) {
        if (!hunk || typeof hunk !== 'object') continue;
        const header = typeof hunk.header === 'string' ? hunk.header : '';
        const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header);
        if (match) {
          const start = Number(match[1]);
          const count = match[2] === undefined ? 1 : Number(match[2]);
          if (count > 0) addRange(start, start + count - 1);
        }
      }
    }
    const container = obj.newLines ?? obj.lines ?? obj.lineNumbers ?? obj.changedLines;
    if (Array.isArray(container) || container instanceof Map || container instanceof Set) {
      visitObject(container);
      if (obj.startLine !== undefined || obj.start !== undefined) {
        addRange(obj.startLine ?? obj.start, obj.endLine ?? obj.end);
      }
      return;
    }
    for (const key of Object.keys(obj)) {
      if (/^\d+$/.test(key)) {
        const value = obj[key];
        pushLine(map, key, typeof value === 'string' ? value : null);
      }
    }
    if (obj.startLine !== undefined || obj.start !== undefined || obj.newStart !== undefined) {
      addRange(obj.startLine ?? obj.start ?? obj.newStart, obj.endLine ?? obj.end ?? obj.newEnd);
    }
    if (obj.line !== undefined || obj.newLine !== undefined || obj.lineNumber !== undefined) {
      pushLine(
        map,
        obj.line ?? obj.newLine ?? obj.lineNumber,
        typeof obj.text === 'string' ? obj.text : typeof obj.content === 'string' ? obj.content : null,
      );
    }
  };

  visitObject(raw);
  if (result.ranges.length === 0 && map.size > 0) {
    // Derive contiguous ranges from the new-line set.
    const numbers = [...map.keys()].sort((a, b) => a - b);
    let start = numbers[0];
    let prev = numbers[0];
    for (let i = 1; i < numbers.length; i += 1) {
      const current = numbers[i];
      if (current !== prev + 1) {
        result.ranges.push({ start, end: prev });
        start = current;
      }
      prev = current;
    }
    result.ranges.push({ start, end: prev });
  }
  return result;
}

/**
 * Resolve new-line info for one file patch, using `lib/git.mjs` when available.
 * @returns {{lines: Map<number,string|null>, ranges: Array<{start:number,end:number}>}}
 */
export function parseNewLinesFromPatch(patch) {
  const fallback = normalizeNewLineInfo(fallbackParsePatchNewLines(patch));
  let fromGit = null;
  if (gitParsePatchNewLines) {
    try {
      fromGit = normalizeNewLineInfo(gitParsePatchNewLines(toText(patch)));
    } catch {
      fromGit = null;
    }
  }
  if (fromGit && fromGit.lines.size > 0) {
    // lib/git.mjs returns `{ newLines: Set<number>, hunks }` (numbers only).
    // Enrich with the patch text so `existing_code` sliding-window matching
    // also works when plan units do not carry full file `content`.
    const hasText = [...fromGit.lines.values()].some((value) => typeof value === 'string');
    if (!hasText && fallback.lines.size > 0) {
      for (const [line, text] of fallback.lines) {
        if (text !== null) fromGit.lines.set(line, text);
      }
    }
    if (fromGit.ranges.length === 0 && fallback.ranges.length > 0) {
      fromGit.ranges = fallback.ranges;
    }
    return fromGit;
  }
  return fallback.lines.size > 0 ? fallback : fromGit ?? fallback;
}

/* ------------------------------------------------------------------------- */
/* content matching                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Find `snippetLines` inside `contentLines` (0-based indices).
 * @returns {{index:number, exact:boolean}|null} index = 0-based start line
 */
function findSnippetWindow(contentLines, snippetLines, lineHint) {
  const total = contentLines.length;
  const size = snippetLines.length;
  if (size === 0 || total === 0 || size > total) return null;

  let startMin = 0;
  let startMax = total - size;
  if (lineHint) {
    const hintIndex = lineHint - 1;
    startMin = Math.max(0, hintIndex - WINDOW_LINES);
    startMax = Math.min(total - size, hintIndex + WINDOW_LINES);
    if (startMax < startMin) startMax = startMin;
    if (startMin > total - size) startMin = Math.max(0, total - size);
  }

  const search = (compare) => {
    let best = null;
    let bestDistance = Infinity;
    for (let index = startMin; index <= startMax; index += 1) {
      let matches = true;
      for (let offset = 0; offset < size; offset += 1) {
        if (!compare(contentLines[index + offset], snippetLines[offset])) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const distance = lineHint ? Math.abs(index + 1 - lineHint) : index;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
      if (!lineHint) break;
    }
    return best;
  };

  const exact = search((a, b) => a === b);
  if (exact !== null) return { index: exact, exact: true };
  const normalized = search((a, b) => normalizeLineText(a) === normalizeLineText(b));
  if (normalized !== null) return { index: normalized, exact: false };
  return null;
}

/** Match an existing_code snippet against the new-line map (no full content). */
function findSnippetInNewLines(newInfo, snippetLines, lineHint) {
  const size = snippetLines.length;
  if (size === 0 || newInfo.lines.size === 0) return null;
  const candidates = [...newInfo.lines.entries()].sort((a, b) => a[0] - b[0]);
  const textByLine = new Map(candidates);
  const isWindowStart = (line) => {
    let start = line;
    // A diff hunk is contiguous; require all snippet lines to be diff new lines.
    for (let offset = 0; offset < size; offset += 1) {
      if (!textByLine.has(start + offset)) return false;
    }
    return true;
  };
  const hintIndex = lineHint ?? null;
  let best = null;
  let bestDistance = Infinity;
  const probe = (line, compare) => {
    if (!isWindowStart(line)) return;
    for (let offset = 0; offset < size; offset += 1) {
      if (!compare(textByLine.get(line + offset), snippetLines[offset])) return;
    }
    const distance = hintIndex === null ? line : Math.abs(line - hintIndex);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  };
  for (const [line] of candidates) {
    if (hintIndex !== null && Math.abs(line - hintIndex) > WINDOW_LINES) continue;
    probe(line, (a, b) => a === b);
    if (best !== null) break;
  }
  if (best === null) {
    for (const [line] of candidates) {
      if (hintIndex !== null && Math.abs(line - hintIndex) > WINDOW_LINES) continue;
      probe(line, (a, b) => normalizeLineText(a) === normalizeLineText(b));
      if (best !== null) break;
    }
  }
  return best === null ? null : { startLine: best, endLine: best + size - 1 };
}

function nearestLine(candidates, line) {
  if (candidates.length === 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function rangeContaining(ranges, line) {
  if (ranges.length === 0) return null;
  if (line !== null) {
    for (const range of ranges) {
      if (line >= range.start && line <= range.end) return range;
    }
    // Nearest range.
    let best = null;
    let bestDistance = Infinity;
    for (const range of ranges) {
      const distance = Math.min(Math.abs(line - range.start), Math.abs(line - range.end));
      if (distance < bestDistance) {
        best = range;
        bestDistance = distance;
      }
    }
    return best;
  }
  return ranges[0];
}

function hunkIdFor(ranges, startLine, endLine) {
  if (ranges.length === 0) return null;
  const line = startLine ?? endLine;
  const index = ranges.findIndex(
    (range) => line !== null && line >= range.start && line <= range.end,
  );
  if (index !== -1) return `h${index + 1}`;
  return null;
}

/* ------------------------------------------------------------------------- */
/* public API                                                                */
/* ------------------------------------------------------------------------- */

function unanchored(finding, reason, extra = {}) {
  return {
    ...finding,
    file: normalizePath(finding.file),
    anchored: false,
    anchorReason: reason,
    startLine: null,
    endLine: null,
    ...extra,
  };
}

/**
 * Anchor reviewer findings to real new-file line ranges.
 *
 * @param {Array<object>} findings Raw findings (may already carry `lens`).
 * @param {{unitId?: string, files?: Array<{path: string, patch?: string, content?: string, status?: string}>}} unit
 * @returns {Array<object>} new findings with `anchored`, `startLine`, `endLine`,
 *   and (when relevant) `anchorReason` / `hunkId`.
 */
export function anchorFindings(findings, unit) {
  const list = Array.isArray(findings) ? findings : [];
  const files = Array.isArray(unit?.files) ? unit.files : [];
  const fileMap = new Map();
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    fileMap.set(normalizePath(file.path), file);
  }

  return list.map((finding) => {
    if (!finding || typeof finding !== 'object') {
      return unanchored({}, 'unmatched');
    }
    const normalizedFile = normalizePath(finding.file);
    const unitFile = fileMap.get(normalizedFile);
    if (!unitFile) return unanchored(finding, 'out-of-scope');

    const lineHint = toLine(finding.line);
    const contentLines =
      typeof unitFile.content === 'string' ? splitLines(unitFile.content) : null;
    const newInfo = parseNewLinesFromPatch(unitFile.patch);
    const newLineNumbers = [...newInfo.lines.keys()].sort((a, b) => a - b);

    // `content` is optional in plan units. In scan mode (no diff) the whole
    // content is the "new" file; in diff mode only patch-added/context lines.
    const candidateLines =
      newLineNumbers.length > 0
        ? newLineNumbers
        : contentLines
          ? contentLines.map((_, index) => index + 1)
          : [];

    const base = { ...finding, file: unitFile.path };

    // 1) existing_code sliding window.
    const snippet = typeof finding.existing_code === 'string' ? finding.existing_code : '';
    if (snippet.trim() !== '') {
      const snippetLines = trimSnippetLines(snippet);
      if (snippetLines.length > 0) {
        if (contentLines) {
          const match = findSnippetWindow(contentLines, snippetLines, lineHint);
          if (match) {
            const startLine = match.index + 1;
            const endLine = startLine + snippetLines.length - 1;
            return {
              ...base,
              anchored: true,
              startLine,
              endLine,
              hunkId: hunkIdFor(newInfo.ranges, startLine, endLine),
            };
          }
        }
        if (newInfo.lines.size > 0) {
          const match = findSnippetInNewLines(newInfo, snippetLines, lineHint);
          if (match) {
            return {
              ...base,
              anchored: true,
              startLine: match.startLine,
              endLine: match.endLine,
              hunkId: hunkIdFor(newInfo.ranges, match.startLine, match.endLine),
            };
          }
        }
      }
    }

    // 2) Clamp `line` to the set of new lines.
    if (lineHint !== null && candidateLines.length > 0) {
      const nearest = nearestLine(candidateLines, lineHint);
      if (nearest !== null) {
        const exact = nearest === lineHint;
        return {
          ...base,
          anchored: true,
          startLine: nearest,
          endLine: nearest,
          anchorReason: exact ? 'line' : 'line-clamped',
          hunkId: hunkIdFor(newInfo.ranges, nearest, nearest),
        };
      }
    }

    // 3) Fall back to the hunk range.
    const range = rangeContaining(newInfo.ranges, lineHint);
    if (range) {
      return {
        ...base,
        anchored: true,
        startLine: range.start,
        endLine: range.end,
        anchorReason: 'hunk-range',
        hunkId: hunkIdFor(newInfo.ranges, range.start, range.end),
      };
    }

    // 4) Nothing to anchor to.
    const reason =
      unitFile.status === 'deleted'
        ? 'deleted-file'
        : newInfo.lines.size === 0 && !contentLines
          ? 'no-content'
          : 'unmatched';
    return unanchored(finding, reason);
  });
}

export default anchorFindings;
