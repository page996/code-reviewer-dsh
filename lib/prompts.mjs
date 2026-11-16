/**
 * lib/prompts.mjs — CONTRACT §4/§6: reviewer / filter prompt assembly + strict
 * JSON parsing for LLM reviewer output.
 *
 * The reviewer protocol is "one JSON object" (optionally fenced):
 *   { findings: [...], verdict: "pass|needs-fix|needs-human", human_attention: [...] }
 *
 * Everything here is pure (no I/O) and deterministic; all instructions are in
 * Chinese because the downstream reviewers are prompted in Chinese.
 */

/** All lenses from CONTRACT §4, with the instruction handed to the reviewer. */
export const LENSES = Object.freeze([
  Object.freeze({
    id: 'intent',
    title: '意图一致性',
    instruction:
      '核对本 diff 是否忠实实现了变更意图（任务契约/关联 issue）：找出遗漏的必要改动、超出意图的额外改动、与契约描述不一致的行为。只在能引用具体 diff 证据时报告。',
  }),
  Object.freeze({
    id: 'correctness',
    title: '正确性',
    instruction:
      '逐条推演改动后的控制流与数据流：条件/边界/off-by-one、返回值与默认值、空值与类型、算术与比较、循环与递归、状态更新顺序。必须给出可复现的错误场景作为证据。',
  }),
  Object.freeze({
    id: 'errors',
    title: '错误处理',
    instruction:
      '检查错误是否被吞掉或错误地捕获、异常路径是否遗漏、失败时资源是否释放、错误信息是否丢失上下文、重试/回退是否会放大故障。只报告本 diff 引入或直接加重的问题。',
  }),
  Object.freeze({
    id: 'concurrency',
    title: '并发与异步',
    instruction:
      '检查异步调用是否被等待、共享可变状态是否有竞态、锁/事务/队列的顺序与重入、取消信号与超时、并发写入导致的丢失更新或死锁。只报告有具体执行顺序证据的问题。',
  }),
  Object.freeze({
    id: 'data',
    title: '数据与持久化',
    instruction:
      '检查数据结构/序列化/迁移/索引/事务的兼容性与正确性：字段语义变化、schema 迁移不可逆、部分写入、排序与分页、精度与编码。关注可能造成数据损坏或无法回滚的问题。',
  }),
  Object.freeze({
    id: 'security',
    title: '安全',
    instruction:
      '检查注入（命令/SQL/模板/路径）、鉴权与越权、敏感信息泄露、输入校验与 SSRF/XXE/反序列化、加密与随机数误用。必须指出具体攻击面与利用路径；不要泛泛而谈“有安全风险”。',
  }),
  Object.freeze({
    id: 'contract',
    title: '接口与契约',
    instruction:
      '检查对外接口（函数签名、HTTP 路由、CLI 参数、事件、配置项、类型）的向后兼容与调用方一致性：破坏性变更、默认值变化、协议字段缺失、版本兼容。列出受影响的调用点作为证据。',
  }),
  Object.freeze({
    id: 'tests',
    title: '测试',
    instruction:
      '检查行为变更是否有对应测试、测试是否真的断言了行为（而不是只跑通）、边界与失败路径是否覆盖、测试是否引入不稳定因素。只报告本 diff 中可指出的缺失或错误测试。',
  }),
  Object.freeze({
    id: 'scope',
    title: '变更范围',
    instruction:
      '检查本 diff 是否夹带与意图无关的改动、重构是否超出必要范围、是否顺手改了公共行为或生成文件。仅当无关改动会带来真实风险（冲突、回滚困难、隐式行为变化）时报告。',
  }),
  Object.freeze({
    id: 'history',
    title: '历史与经验',
    instruction:
      '结合规则包与已知教训，检查本次改动是否重蹈历史缺陷（同类 bug 再次出现、旧问题被重新引入、既有 workaround 被破坏）。指出对应的规则/历史证据。',
  }),
]);

export const LENS_IDS = Object.freeze(LENSES.map((lens) => lens.id));

/** Valid categories / severities for reviewer output validation. */
export const CATEGORIES = Object.freeze([
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
  'style',
  'docs',
  'other',
]);

export const SEVERITIES = Object.freeze(['blocker', 'major', 'minor']);
export const VERDICTS = Object.freeze(['pass', 'needs-fix', 'needs-human']);
export const FILTER_DECISIONS = Object.freeze(['keep', 'drop']);

const CATEGORY_SET = new Set(CATEGORIES);
const SEVERITY_SET = new Set(SEVERITIES);
const VERDICT_SET = new Set(VERDICTS);

/** The output contract embedded into every reviewer prompt. */
export const REVIEWER_OUTPUT_SCHEMA = Object.freeze({
  findings: [
    {
      file: 'src/example.mjs',
      existing_code: '从新文件内容中逐字复制的片段',
      line: 42,
      category: 'correctness',
      severity: 'major',
      problem: '一句话描述问题',
      evidence: '为什么能证明这是问题（引用 diff/新代码）',
      impact: '不修复的实际后果',
      suggestion: '可执行的修复建议',
      preexisting: false,
    },
  ],
  verdict: 'pass|needs-fix|needs-human',
  human_attention: ['需要人工确认、但当前证据不足以定为缺陷的点'],
});

/** The output contract embedded into every filter prompt. */
export const FILTER_OUTPUT_SCHEMA = Object.freeze([
  { fingerprint: 'sha1 hex from input', decision: 'keep|drop', reason: '依据本 diff 的具体证据' },
]);

const BASE_RULES = [
  '只报告本 diff 中能用证据支撑的问题；没有证据的猜测不要写进 findings。',
  '禁止报告纯风格、命名、格式、注释措辞类问题（style/docs + minor 会被自动丢弃）。',
  '每条 finding 必须包含 file（unit 内的相对 POSIX 路径）、evidence（对本 diff/新文件的逐字引用或可定位行）、impact（不修复的实际后果）、suggestion（可执行的修法）。',
  'existing_code 必须从新文件内容中逐字复制（保留缩进与换行），不得改写、省略、拼接；若无法给出逐字片段则留空并给出 line。',
  '若问题在本 diff 之前就已存在，设 preexisting=true，不要把它当作本 diff 引入的问题。',
  '无法证明但值得人工确认的断言必须放入 human_attention（字符串数组），不得伪装成 finding。',
  '同一问题只报告一次，不要为凑数量重复报告。',
];

function lensOf(lens) {
  if (typeof lens === 'string') {
    const found = LENSES.find((item) => item.id === lens);
    if (found) return found;
    return { id: lens, title: lens, instruction: `以「${lens}」视角评审本 diff，只报告有证据的问题。` };
  }
  if (lens && typeof lens === 'object') {
    return {
      id: typeof lens.id === 'string' ? lens.id : 'unknown',
      title: typeof lens.title === 'string' ? lens.title : String(lens.id ?? 'unknown'),
      instruction:
        typeof lens.instruction === 'string' && lens.instruction.trim()
          ? lens.instruction
          : `以「${lens.id ?? 'unknown'}」视角评审本 diff，只报告有证据的问题。`,
    };
  }
  return { id: 'unknown', title: 'unknown', instruction: '评审本 diff，只报告有证据的问题。' };
}

function contractText(contract) {
  if (contract === null || contract === undefined) return null;
  if (typeof contract === 'string') {
    const text = contract.trim();
    return text === '' ? null : text;
  }
  if (typeof contract === 'object') {
    const text =
      typeof contract.text === 'string'
        ? contract.text
        : typeof contract.content === 'string'
          ? contract.content
          : '';
    const trimmed = text.trim();
    if (trimmed !== '') return trimmed;
    try {
      return JSON.stringify(contract);
    } catch {
      return null;
    }
  }
  return String(contract);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => file && typeof file === 'object' && typeof file.path === 'string')
    .map((file) => {
      const out = {
        path: file.path,
        newLineCount:
          Number.isFinite(Number(file.newLineCount)) && Number(file.newLineCount) >= 0
            ? Math.floor(Number(file.newLineCount))
            : null,
      };
      if (typeof file.patch === 'string') out.patch = file.patch;
      if (typeof file.content === 'string') out.content = file.content;
      if (typeof file.status === 'string') out.status = file.status;
      if (typeof file.oldPath === 'string') out.oldPath = file.oldPath;
      return out;
    });
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      id: String(rule.id ?? ''),
      source: typeof rule.source === 'string' ? rule.source : 'unknown',
      title: String(rule.title ?? ''),
      body: typeof rule.body === 'string' ? rule.body : '',
    }));
}

function rulesToText(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  return rules
    .map((rule) => {
      const head = `[${rule.id || 'rule'}]${rule.title ? ` ${rule.title}` : ''}`;
      return rule.body ? `${head}\n${rule.body}` : head;
    })
    .join('\n\n');
}

const SYSTEM_REVIEWER = [
  '你是一名资深代码评审专家，正在一个独立的评审单元（unit）上以指定视角检查一个代码变更。',
  '你只能依据用户消息中提供的 diff、新文件内容、规则和任务契约作判断，不得臆测未提供的代码。',
  '只报告本 diff 引入或本 diff 直接加重、并且能用证据支撑的问题；纯风格/命名/格式问题禁止报告。',
  '输出必须是一个 JSON 对象（可被 ```json 围栏包裹），JSON 之外不得有任何文字。',
  '字段与硬性规则见用户消息中的 outputSchema 与 hardRules；无法证明的断言放入 human_attention。',
].join('\n');

/**
 * Build the reviewer prompt for one (unit, lens) pair.
 * @returns {{system: string, user: string}}
 */
export function buildReviewerPrompt({ unit, lens, contract, maxComments } = {}) {
  const resolvedLens = lensOf(lens);
  const limit =
    Number.isFinite(Number(maxComments)) && Number(maxComments) > 0
      ? Math.floor(Number(maxComments))
      : 30;
  const files = normalizeFiles(unit?.files);
  const rules = normalizeRules(unit?.rules);
  const contractValue = contractText(contract);

  const hardRules = [
    ...BASE_RULES,
    `最多输出 ${limit} 条 findings；按严重程度从高到低排序，超过上限的只保留最严重的。`,
    `category 必须取 ${CATEGORIES.join(' | ')} 之一；severity 必须取 ${SEVERITIES.join(' | ')} 之一。`,
    '若存在阻断级问题，verdict=needs-fix；若需要人工判断，verdict=needs-human；否则 verdict=pass。',
    '输出格式固定为：{"findings":[...],"verdict":"pass|needs-fix|needs-human","human_attention":[...]}。',
  ];

  const priorFindings = Array.isArray(unit?.priorFindings)
    ? unit.priorFindings.filter((finding) => finding && typeof finding === 'object')
    : [];
  if (priorFindings.length > 0) {
    hardRules.unshift(
      '这是第 2 轮复核：只复核 priorFindings 中已确认的问题是否仍然存在，并检查受影响文件的新 diff；不要扩散到无关文件或引入与复核目标无关的新问题。',
      '对仍然存在的问题照常输出 finding（可沿用原 fingerprint 或提供相同 file/category/描述）；已修复的问题不要输出；只对无法判断是否修复的情况写 human_attention。',
    );
  }

  const payload = {
    task: priorFindings.length > 0 ? 'code-review/round2-verify' : 'code-review/unit-lens',
    lens: resolvedLens,
    round: Number.isFinite(Number(unit?.round)) ? Number(unit.round) : 1,
    unit: {
      unitId: typeof unit?.unitId === 'string' ? unit.unitId : '',
      files,
      rules,
      stats: unit?.stats ?? null,
      ...(priorFindings.length > 0 ? { priorFindings } : {}),
    },
    rulesText: rulesToText(rules),
    contract: contractValue,
    limits: { maxComments: limit },
    outputSchema: REVIEWER_OUTPUT_SCHEMA,
    hardRules,
  };

  const intro =
    priorFindings.length > 0
      ? '请复核下面这个变更单元中已确认的问题。所有输入都在 JSON 块中，请严格按 lens.instruction 与 hardRules 输出一个 JSON 对象。'
      : '请评审下面这个变更单元。所有输入都在 JSON 块中，请严格按 lens.instruction 与 hardRules 输出一个 JSON 对象。';

  const user = [
    intro,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  return { system: SYSTEM_REVIEWER, user };
}

/* ------------------------------------------------------------------------- */
/* lenient JSON extraction                                                   */
/* ------------------------------------------------------------------------- */

function stripFences(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, '')
    .replace(/```/g, '');
}

function sliceBetween(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  const end = text.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function parseJsonLoose(text, openChar, closeChar) {
  const stripped = stripFences(text);
  const candidate = sliceBetween(stripped, openChar, closeChar);
  if (!candidate) return { ok: false, error: `未找到 JSON ${openChar}…${closeChar} 块` };
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败: ${err?.message ?? err}` };
  }
}

function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function toLine(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toBool(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function normalizeFinding(raw, index) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const categoryRaw = toText(source.category).toLowerCase();
  const severityRaw = toText(source.severity).toLowerCase();
  const finding = {
    ...source,
    file: toText(source.file),
    existing_code: typeof source.existing_code === 'string' ? source.existing_code : '',
    line: toLine(source.line),
    category: CATEGORY_SET.has(categoryRaw) ? categoryRaw : 'other',
    severity: SEVERITY_SET.has(severityRaw) ? severityRaw : 'minor',
    problem: toText(source.problem ?? source.title ?? source.message),
    evidence: toText(source.evidence),
    impact: toText(source.impact),
    suggestion: toText(source.suggestion ?? source.fix),
    preexisting: toBool(source.preexisting),
  };
  if (source.category !== undefined && !CATEGORY_SET.has(categoryRaw)) {
    finding.categoryInvalid = toText(source.category);
  }
  if (source.severity !== undefined && !SEVERITY_SET.has(severityRaw)) {
    finding.severityInvalid = toText(source.severity);
  }
  // Stable helper for prompts/debugging; not part of the contract.
  finding._index = index;
  return finding;
}

function normalizeHumanAttention(parsed) {
  const raw = parsed?.human_attention ?? parsed?.humanAttention;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item.trim() : toText(item)))
    .filter((item) => item !== '');
}

/**
 * Parse one reviewer response. Never throws.
 * @returns {{findings: Array, verdict: string, humanAttention: string[], schemaError?: string}}
 */
export function parseReviewerOutput(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { findings: [], verdict: 'pass', humanAttention: [], schemaError: 'LLM 输出为空' };
  }
  const parsed = parseJsonLoose(text, '{', '}');
  if (!parsed.ok) {
    return { findings: [], verdict: 'pass', humanAttention: [], schemaError: parsed.error };
  }
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      findings: [],
      verdict: 'pass',
      humanAttention: [],
      schemaError: 'reviewer 输出不是 JSON 对象',
    };
  }

  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  const findings = rawFindings
    .filter((finding) => finding && typeof finding === 'object' && !Array.isArray(finding))
    .map((finding, index) => normalizeFinding(finding, index));

  const humanAttention = normalizeHumanAttention(value);
  const verdictRaw = toText(value.verdict).toLowerCase();
  let verdict;
  if (VERDICT_SET.has(verdictRaw)) verdict = verdictRaw;
  else if (findings.length > 0) verdict = 'needs-fix';
  else if (humanAttention.length > 0) verdict = 'needs-human';
  else verdict = 'pass';

  return { findings, verdict, humanAttention };
}

/** Parse one filter response. Never throws. */
export function parseFilterOutput(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { decisions: [], schemaError: 'filter 输出为空' };
  }
  let parsed = parseJsonLoose(text, '[', ']');
  let rawList = null;
  if (parsed.ok && Array.isArray(parsed.value)) {
    rawList = parsed.value;
  } else {
    const objectForm = parseJsonLoose(text, '{', '}');
    if (objectForm.ok && objectForm.value && typeof objectForm.value === 'object') {
      const candidate = objectForm.value.decisions ?? objectForm.value.results ?? objectForm.value.findings;
      if (Array.isArray(candidate)) rawList = candidate;
    }
  }
  if (!rawList) {
    return {
      decisions: [],
      schemaError: parsed.ok ? 'filter 输出不是 JSON 数组' : parsed.error,
    };
  }
  const decisions = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const fingerprint = toText(item.fingerprint);
    if (!fingerprint) continue;
    const decisionRaw = toText(item.decision).toLowerCase();
    decisions.push({
      fingerprint,
      decision: decisionRaw === 'drop' ? 'drop' : 'keep',
      reason: toText(item.reason),
    });
  }
  return { decisions };
}

/* ------------------------------------------------------------------------- */
/* filter prompt                                                             */
/* ------------------------------------------------------------------------- */

const SYSTEM_FILTER = [
  '你是一名保守的代码评审假阳性过滤器。你的唯一任务是判断评审 findings 中哪些能被当前 diff 直接证明为假。',
  '默认保留：任何需要额外代码上下文、需要运行才能确认、或证据不足的判断都必须保留（keep）。',
  '只有当 diff/新文件内容本身明确证明该 finding 描述的问题不存在（例如声称的问题代码根本不在本 diff、描述与实际代码相反、重复报告）时才允许 drop。',
  '输出必须是一个 JSON 数组（可被 ```json 围栏包裹），JSON 之外不得有任何文字。',
].join('\n');

/**
 * Build the (unit, findings) false-positive filter prompt.
 * @returns {{system: string, user: string}}
 */
export function buildFilterPrompt({ unit, findings } = {}) {
  const files = normalizeFiles(unit?.files);
  const items = Array.isArray(findings)
    ? findings
        .filter((finding) => finding && typeof finding === 'object')
        .map((finding) => ({
          fingerprint: toText(finding.fingerprint),
          file: toText(finding.file),
          startLine: toLine(finding.startLine ?? finding.line),
          endLine: toLine(finding.endLine ?? finding.startLine ?? finding.line),
          category: CATEGORY_SET.has(toText(finding.category).toLowerCase())
            ? toText(finding.category).toLowerCase()
            : 'other',
          severity: SEVERITY_SET.has(toText(finding.severity).toLowerCase())
            ? toText(finding.severity).toLowerCase()
            : 'minor',
          problem: toText(finding.problem),
          evidence: toText(finding.evidence),
          suggestion: toText(finding.suggestion),
          existing_code: typeof finding.existing_code === 'string' ? finding.existing_code : '',
        }))
    : [];

  const hardRules = [
    '只删除本 diff 能直接证明为假的 finding；任何不确定、缺上下文、需要运行才能判断的情况一律 keep。',
    'preexisting=true 不是删除理由（它只影响阻断级别）。',
    '不得因为“风格问题”“不够严重”“可能是误报”而 drop；这些默认 keep。',
    'fingerprint 必须原样返回输入中的值，一条不漏（理想情况下对每条 finding 都给出 decision）。',
    'decision 只能是 keep 或 drop；reason 必须引用本 diff 中的具体依据，drop 时尤其要写清楚。',
    '输出为 JSON 数组：[{"fingerprint":"...","decision":"keep|drop","reason":"..."}]。',
  ];

  const payload = {
    task: 'code-review/false-positive-filter',
    unit: { unitId: typeof unit?.unitId === 'string' ? unit.unitId : '', files },
    findings: items,
    outputSchema: FILTER_OUTPUT_SCHEMA,
    hardRules,
  };

  const user = [
    '请保守过滤下面的 findings。所有输入都在 JSON 块中；只有本 diff 能直接证明为假时才 drop，其余一律 keep。',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  return { system: SYSTEM_FILTER, user };
}

export default {
  LENSES,
  LENS_IDS,
  CATEGORIES,
  SEVERITIES,
  VERDICTS,
  buildReviewerPrompt,
  parseReviewerOutput,
  buildFilterPrompt,
  parseFilterOutput,
};
