const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG = path.join(os.tmpdir(), 'ci-review-bridge.log');
const MAX_LINES = 3000;
const FLUSH_DELAY_MS = 180;
const RETRY_DELAY_MS = 1500;

let target = null;
let flushTimer = null;
let inFlight = false;
const pending = new Map();
const lastSentVersion = new Map();

function log(message) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
}

function post(bodyJson) {
  return new Promise((resolve) => {
    if (!target) return resolve(false);
    const data = Buffer.from(bodyJson, 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        path: `/dsh-ci-review/api/vscode/push?token=${encodeURIComponent(target.token)}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          'x-dsh-ci-review-token': target.token,
        },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      },
    );
    req.on('error', (error) => { log(`push error: ${error.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(); log('push timeout'); resolve(false); });
    req.write(data);
    req.end();
  });
}

function enqueue(payload) {
  pending.set(payload.file, payload);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush() {
  if (!target || inFlight) {
    if (inFlight) setTimeout(() => void flush(), 250);
    return;
  }
  const items = [...pending.values()];
  if (items.length === 0) return;
  pending.clear();
  inFlight = true;
  const payload = items.length === 1 ? items[0] : { type: 'batch', buffers: items };
  const ok = await post(JSON.stringify(payload));
  inFlight = false;
  if (ok) {
    for (const item of items) lastSentVersion.set(item.file, item.version);
    if (pending.size > 0) setTimeout(() => void flush(), 30);
    return;
  }
  // Coalesced retry: keep only the newest payload per file and try again.
  for (const item of items) {
    if (!pending.has(item.file)) pending.set(item.file, item);
  }
  setTimeout(() => void flush(), RETRY_DELAY_MS);
}

function snapshot(document) {
  const file = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  const diagnostics = vscode.languages.getDiagnostics(document.uri).map((item) => ({
    severity: ['error', 'warning', 'info', 'hint'][item.severity] || 'info',
    line: item.range.start.line + 1,
    column: item.range.start.character + 1,
    message: item.message,
    source: item.source || '',
  }));
  const allLines = document.getText().split('\n');
  const truncated = allLines.length > MAX_LINES;
  return {
    type: 'buffer',
    file,
    absPath: document.uri.fsPath.replace(/\\/g, '/'),
    languageId: document.languageId,
    version: document.version,
    dirty: document.isDirty,
    truncated,
    lines: truncated ? allLines.slice(0, MAX_LINES) : allLines,
    diagnostics,
  };
}

function readDiscovery() {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(home, 'ci-review-bridge.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.token && data.port) return { port: Number(data.port), token: String(data.token) };
  } catch {
    /* no discovery file yet */
  }
  return null;
}

function connect(overrides = {}) {
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  const port = overrides.port || config.get('port', 0);
  const token = overrides.token || config.get('token', '');
  log(`connect port=${port} tokenLen=${token.length} workspace=${vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || ''}`);
  if (!token || !port) {
    vscode.window.showWarningMessage('CI Review Bridge: 未找到 DSH 连接信息（先打开 DSH CI 评审面板，或运行配对脚本）');
    return;
  }
  target = { port, token };
  pending.clear();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  post(JSON.stringify({ type: 'hello', workspaceRoot: root.replace(/\\/g, '/'), vscodeVersion: vscode.version, extensionVersion: '0.1.8' }))
    .then((ok) => log(`hello accepted=${ok}`));
  const editor = vscode.window.activeTextEditor;
  if (editor) enqueue(snapshot(editor.document));
}

function activate(context) {
  log('activate');
  context.subscriptions.push(vscode.commands.registerCommand('ciReviewBridge.connect', () => connect()));
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path !== '/connect') return;
      const params = new URLSearchParams(uri.query);
      connect({ port: Number(params.get('port')) || undefined, token: params.get('token') || '' });
    },
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (target && vscode.window.activeTextEditor?.document === event.document) enqueue(snapshot(event.document));
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (target && editor) enqueue(snapshot(editor.document));
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    const editor = vscode.window.activeTextEditor;
    if (target && editor) enqueue(snapshot(editor.document));
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('ciReviewBridge')) connect();
  }));
  const discovery = readDiscovery();
  log(`discovery ${discovery ? `port=${discovery.port}` : 'missing'}`);
  if (discovery) connect({ port: discovery.port, token: discovery.token });
  else connect();
  const watcher = setInterval(() => {
    const next = readDiscovery();
    if (!next) return;
    if (!target || next.port !== target.port || next.token !== target.token) {
      log(`discovery changed -> reconnect port=${next.port}`);
      connect({ port: next.port, token: next.token });
    }
  }, 5000);
  context.subscriptions.push({ dispose() { clearInterval(watcher); } });
}

function deactivate() {
  target = null;
  pending.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  log('deactivate');
}

module.exports = { activate, deactivate };
