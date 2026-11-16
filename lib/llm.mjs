/**
 * lib/llm.mjs — CONTRACT §5: LLM transport layer.
 *
 * `createLlm({ model, cwd, env })` returns `{ complete(req), describe() }`.
 *
 * Transports:
 *   - anthropic (default): POST {base}/v1/messages, SSE streaming.
 *   - openai (optional):   POST {base}/v1/chat/completions, SSE streaming.
 *
 * Design constraints honoured here:
 *   - zero npm dependencies, global `fetch` (Node >= 22);
 *   - NEVER print / return the API key (errors are redacted);
 *   - no top-level I/O (`.env` is only read lazily from inside `createLlm`);
 *   - retries: 2 for 429 / 5xx / network / timeout with 1s & 3s backoff;
 *   - caller `signal` aborts immediately; 300s idle timeout per request.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';
const DEFAULT_OPENAI_BASE = 'https://api.deepseek.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_MAX_TOKENS = 256000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_DELAYS = [1000, 3000];
const ERROR_BODY_PREVIEW = 800;
const TRANSPORTS = new Set(['anthropic', 'openai']);

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function makeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) err[key] = value;
  }
  return err;
}

/** Replace a secret (and anything that looks like it) inside diagnostic text. */
function redact(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(String(secret)).join('[redacted]');
  // Common key shapes, defensive only (we never intentionally put keys in text).
  out = out.replace(/\b(sk|ak)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
  return out;
}

function trimBody(body) {
  const text = String(body ?? '').trim();
  return text.length > ERROR_BODY_PREVIEW ? `${text.slice(0, ERROR_BODY_PREVIEW)}…` : text;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function toInteger(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Minimal .env reader: `KEY=value`, optional `export `, quotes, comments. */
function parseDotenv(text) {
  const out = Object.create(null);
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

function readDotenvFile(filePath) {
  try {
    return parseDotenv(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeBaseUrl(raw) {
  if (!isNonEmptyString(raw)) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

function endpointFor(transport, baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (transport === 'openai') {
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function envProperty(env, name) {
  if (!name) return undefined;
  const value = env?.[name];
  return isNonEmptyString(value) ? value : undefined;
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function numberOr0(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Normalize usage fields from either anthropic-style or openai-style payloads. */
function readUsage(obj) {
  const usage = obj && typeof obj === 'object' ? obj : {};
  return {
    inputTokens: numberOr0(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens),
    outputTokens: numberOr0(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens),
    cacheReadTokens: numberOr0(
      usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cache_read_tokens,
    ),
    cacheWriteTokens: numberOr0(
      usage.cache_creation_input_tokens ??
        usage.cacheWriteTokens ??
        usage.cache_creation_tokens ??
        usage.cache_write_tokens,
    ),
  };
}

function mergeUsage(target, extra) {
  for (const key of Object.keys(target)) {
    if (extra[key] > 0) target[key] = extra[key];
  }
  return target;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true }));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function parseRetryDelays(env) {
  const raw = env?.REVIEW_LLM_RETRY_DELAYS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const values = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (values.length > 0) return values;
  }
  return DEFAULT_RETRY_DELAYS;
}

function idleTimeoutMs(env) {
  return toInteger(env?.REVIEW_LLM_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
}

function isRetryable(err) {
  if (!err?.code) return false;
  if (err.aborted) return false;
  if (err.code === 'LLM_RATE_LIMIT' || err.code === 'LLM_SERVER' || err.code === 'LLM_TIMEOUT') {
    return true;
  }
  const match = /^LLM_HTTP_(\d{3})$/.exec(err.code);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 408 || status === 429 || status >= 500;
}

/* ------------------------------------------------------------------------- */
/* SSE parsing                                                               */
/* ------------------------------------------------------------------------- */

function anthropicErrorFromEvent(event, secret, redactText) {
  const type = event?.error?.type ?? event?.type ?? '';
  const message = redactText(event?.error?.message ?? 'anthropic stream error');
  if (/rate_limit|overloaded/.test(type) || type === 'overloaded_error') {
    return makeError('LLM_RATE_LIMIT', message, { transport: 'anthropic' });
  }
  if (/authentication|permission/.test(type)) {
    return makeError('LLM_AUTH', message, { transport: 'anthropic' });
  }
  void secret;
  return makeError('LLM_SERVER', message, { transport: 'anthropic' });
}

/**
 * Consume an SSE response body and return the transport-specific result.
 * `onData` receives each decoded `data:` JSON object (non-JSON data ignored).
 */
async function consumeSse(res, { signal, timeoutMs, onData, redactText }) {
  const body = res.body;
  if (!body) throw makeError('LLM_SERVER', '响应没有 body', { retryable: false });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer = null;
  let timedOut = false;
  let abortedByCaller = false;

  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, timeoutMs);
  };
  const onAbort = () => {
    abortedByCaller = true;
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // tolerate keep-alive / non-JSON data lines
    }
    onData(parsed);
  };

  try {
    arm();
    for (;;) {
      if (signal?.aborted) {
        abortedByCaller = true;
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) handleLine(line);
    }
  } catch (err) {
    if (timedOut || abortedByCaller) {
      // settled below
    } else {
      throw makeError('LLM_SERVER', redactText(`读取流失败: ${err?.message ?? err}`), {
        transport: 'sse',
      });
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released/cancelled */
    }
  }

  if (abortedByCaller || signal?.aborted) {
    throw makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true });
  }
  if (timedOut) {
    throw makeError('LLM_TIMEOUT', `LLM 空闲超时（${timeoutMs}ms）`, { timeoutMs });
  }
}

/* ------------------------------------------------------------------------- */
/* createLlm                                                                 */
/* ------------------------------------------------------------------------- */

export function createLlm({ model, cwd, env } = {}) {
  const config = model && typeof model === 'object' ? model : {};
  const workDir = isNonEmptyString(cwd) ? cwd : process.cwd();
  const environment = env && typeof env === 'object' ? env : process.env;

  const transport = isNonEmptyString(config.transport) ? config.transport.trim() : 'anthropic';
  if (!TRANSPORTS.has(transport)) {
    throw makeError('CONFIG', `不支持的 model.transport: ${transport}（可选 anthropic|openai）`);
  }
  const modelId = isNonEmptyString(config.model) ? config.model.trim() : DEFAULT_MODEL;
  const effort =
    config.reasoningEffort === null || config.reasoningEffort === undefined
      ? 'max'
      : String(config.reasoningEffort);
  const baseUrlEnv = isNonEmptyString(config.baseUrlEnv)
    ? config.baseUrlEnv.trim()
    : 'DEEPSEEK_BASE_URL';
  const apiKeyEnv = isNonEmptyString(config.apiKeyEnv)
    ? config.apiKeyEnv.trim()
    : 'DEEPSEEK_API_KEY';
  const defaultMaxTokens = toInteger(config.maxTokens, DEFAULT_MAX_TOKENS);
  const retryDelays = parseRetryDelays(environment);
  const timeoutMs = idleTimeoutMs(environment);

  // ---- env / .env resolution (lazy on first use, never top-level I/O) ----
  let dotenvCache;
  const dotenvFiles = () => {
    const files = [];
    files.push(join(workDir, '.env'));
    // $DSH_HOME/.env only when the caller-supplied env carries DSH_HOME; callers
    // such as the CLI pass `resolveEnv(...)`, which includes process env + .env.
    const dshHome = envProperty(environment, 'DSH_HOME');
    if (dshHome) files.push(join(dshHome, '.env'));
    return files;
  };
  const resolveValue = (name) => {
    const fromEnv = envProperty(environment, name);
    if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
    if (dotenvCache === undefined) {
      dotenvCache = [];
      for (const file of dotenvFiles()) {
        const parsed = readDotenvFile(file);
        if (parsed) dotenvCache.push(parsed);
      }
    }
    for (const parsed of dotenvCache) {
      const value = parsed[name];
      if (isNonEmptyString(value)) return { value, source: '.env' };
    }
    return { value: undefined, source: null };
  };

  const explicitBase = resolveValue(baseUrlEnv).value;
  const baseUrl =
    normalizeBaseUrl(config.baseUrl) ??
    normalizeBaseUrl(explicitBase) ??
    (transport === 'openai' ? DEFAULT_OPENAI_BASE : DEFAULT_ANTHROPIC_BASE);
  const endpoint = endpointFor(transport, baseUrl);

  const getApiKey = () => resolveValue(apiKeyEnv).value ?? null;

  /** Sanitize any diagnostic string so the key can never leak. */
  const redactText = (text) => redact(text, getApiKey());

  const requireApiKey = () => {
    const key = getApiKey();
    if (!key) {
      throw makeError(
        'LLM_AUTH',
        `缺少 API key：请设置环境变量 ${apiKeyEnv}，或在 ${join(workDir, '.env')} / $DSH_HOME/.env 中配置`,
        { envVar: apiKeyEnv },
      );
    }
    return key;
  };

  const buildHeaders = (key) => {
    if (transport === 'openai') {
      return {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
    }
    return {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
  };

  const buildPayload = (req) => {
    const maxTokens = toInteger(req?.maxTokens ?? config.maxTokens, defaultMaxTokens);
    const system = typeof req?.system === 'string' ? req.system : '';
    const user = typeof req?.user === 'string' ? req.user : String(req?.user ?? '');
    const body = {
      model: modelId,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      stream: true,
      thinking: { type: 'enabled' },
      output_config: { effort },
    };
    if (typeof req?.temperature === 'number') body.temperature = req.temperature;
    return body;
  };

  const buildOpenAiPayload = (req) => {
    const maxTokens = toInteger(req?.maxTokens ?? config.maxTokens, defaultMaxTokens);
    const system = typeof req?.system === 'string' ? req.system : '';
    const user = typeof req?.user === 'string' ? req.user : String(req?.user ?? '');
    const body = {
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      stream: true,
      reasoning_effort: effort,
    };
    if (typeof req?.temperature === 'number') body.temperature = req.temperature;
    return body;
  };

  const parseAnthropicEvent = (state, event) => {
    const type = event?.type;
    if (type === 'error') throw anthropicErrorFromEvent(event, null, redactText);
    if (type === 'message_start') {
      if (event.message?.model) state.responseModel = event.message.model;
      mergeUsage(state.usage, readUsage(event.message?.usage));
      return;
    }
    if (type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'text' && typeof block.text === 'string') state.text += block.text;
      return;
    }
    if (type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') state.text += delta.text;
      return;
    }
    if (type === 'message_delta') {
      if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
      mergeUsage(state.usage, readUsage(event.usage));
      return;
    }
    if (type === 'message_stop') {
      state.stopped = true;
    }
  };

  const parseOpenAiEvent = (state, event) => {
    if (event?.error) {
      const message = redactText(event.error.message ?? 'openai stream error');
      const status = Number(event.error.status ?? event.error.code ?? 0);
      if (status === 401 || status === 403) throw makeError('LLM_AUTH', message);
      if (status === 429) throw makeError('LLM_RATE_LIMIT', message);
      throw makeError('LLM_SERVER', message);
    }
    mergeUsage(state.usage, readUsage(event?.usage));
    if (event?.model) state.responseModel = event.model;
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') {
      state.text += delta.content;
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (typeof part?.text === 'string') state.text += part.text;
      }
    }
    if (typeof delta.reasoning_content === 'string' && state.reasoningText === '') {
      // DeepSeek-style reasoning field: keep it out of `text`, only remember it exists.
      state.reasoningText = delta.reasoning_content;
    }
    if (choice.finish_reason) state.stopReason = choice.finish_reason;
  };

  const parseAnthropicJson = (json, state) => {
    if (!json || typeof json !== 'object') {
      throw makeError('LLM_SERVER', '响应不是合法的 JSON 对象');
    }
    if (json.type === 'error') throw anthropicErrorFromEvent(json, null, redactText);
    const blocks = Array.isArray(json.content) ? json.content : [];
    const texts = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
    state.text = texts.join('');
    state.responseModel = json.model ?? state.responseModel;
    state.stopReason = json.stop_reason ?? state.stopReason;
    mergeUsage(state.usage, readUsage(json.usage));
    state.stopped = true;
  };

  const parseOpenAiJson = (json, state) => {
    if (!json || typeof json !== 'object') {
      throw makeError('LLM_SERVER', '响应不是合法的 JSON 对象');
    }
    if (json.error) {
      throw makeError('LLM_SERVER', redactText(json.error.message ?? 'openai error'));
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const content = choice?.message?.content;
    if (typeof content === 'string') state.text = content;
    else if (Array.isArray(content)) {
      state.text = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    state.responseModel = json.model ?? state.responseModel;
    state.stopReason = choice?.finish_reason ?? state.stopReason;
    mergeUsage(state.usage, readUsage(json.usage));
    state.stopped = true;
  };

  const mapHttpError = (status, bodyText) => {
    const message = redactText(
      `LLM HTTP ${status}${bodyText ? `: ${trimBody(bodyText)}` : ''}`,
    );
    if (status === 401 || status === 403) return makeError('LLM_AUTH', message, { status });
    if (status === 429) return makeError('LLM_RATE_LIMIT', message, { status });
    if (status >= 500) return makeError('LLM_SERVER', message, { status });
    return makeError(`LLM_HTTP_${status}`, message, { status });
  };

  const requestOnce = async (req) => {
    const key = requireApiKey();
    const callerSignal = req?.signal;
    if (callerSignal?.aborted) {
      throw makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true });
    }

    const controller = new AbortController();
    let timedOut = false;
    let abortedByCaller = false;
    const idle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => {
      abortedByCaller = true;
      controller.abort();
    };
    callerSignal?.addEventListener?.('abort', onAbort, { once: true });

    const state = {
      text: '',
      usage: emptyUsage(),
      stopReason: null,
      responseModel: null,
      stopped: false,
      reasoningText: '',
    };
    const isAnthropic = transport === 'anthropic';
    const payload = isAnthropic ? buildPayload(req) : buildOpenAiPayload(req);
    const headers = buildHeaders(key);

    let response;
    try {
      response = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(idle);
    } catch (err) {
      clearTimeout(idle);
      callerSignal?.removeEventListener?.('abort', onAbort);
      if (abortedByCaller || callerSignal?.aborted) {
        throw makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true });
      }
      if (timedOut) {
        throw makeError('LLM_TIMEOUT', `LLM 空闲超时（${timeoutMs}ms）`, { timeoutMs });
      }
      throw makeError(
        'LLM_SERVER',
        redactText(`LLM 网络错误: ${err?.message ?? err}`),
        { network: true, cause: err?.code ?? undefined },
      );
    }

    if (!response.ok) {
      callerSignal?.removeEventListener?.('abort', onAbort);
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '';
      }
      throw mapHttpError(response.status, bodyText);
    }

    // A non-SSE response may still be valid (some gateways ignore `stream`).
    const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    const wantsStream = contentType.includes('text/event-stream');
    try {
      if (wantsStream) {
        await consumeSse(response, {
          signal: callerSignal,
          timeoutMs,
          redactText,
          onData: (event) =>
            isAnthropic
              ? parseAnthropicEvent(state, event)
              : parseOpenAiEvent(state, event),
        });
      } else {
        let json;
        try {
          json = await response.json();
        } catch {
          throw makeError('LLM_SERVER', 'LLM 响应无法解析为 JSON');
        }
        if (state.reasoningText && !state.text) {
          // Reasoning-only payloads are not review output; leave text empty.
        }
        isAnthropic ? parseAnthropicJson(json, state) : parseOpenAiJson(json, state);
      }
    } catch (err) {
      if (abortedByCaller || callerSignal?.aborted) {
        throw makeError('LLM_TIMEOUT', '请求已被调用方取消', { aborted: true });
      }
      if (timedOut) throw makeError('LLM_TIMEOUT', `LLM 空闲超时（${timeoutMs}ms）`, { timeoutMs });
      throw err;
    } finally {
      clearTimeout(idle);
      callerSignal?.removeEventListener?.('abort', onAbort);
    }

    return {
      text: state.text,
      usage: state.usage,
      stopReason: state.stopReason ?? (state.stopped ? 'end_turn' : null),
      model: state.responseModel ?? modelId,
      effort,
    };
  };

  const complete = async (req = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return await requestOnce(req);
      } catch (err) {
        lastError = err;
        const canRetry = isRetryable(err) && attempt < retryDelays.length;
        if (!canRetry) break;
        await sleep(retryDelays[attempt], req?.signal);
      }
    }
    throw lastError ?? makeError('LLM_SERVER', 'LLM 调用失败');
  };

  const describe = () => ({
    transport,
    model: modelId,
    effort,
    baseUrlHost: hostOf(baseUrl),
  });

  return { complete, describe };
}

export default createLlm;
