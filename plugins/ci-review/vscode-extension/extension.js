const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG = path.join(os.tmpdir(), 'ci-review-bridge.log');
let target = null;

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
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-dsh-ci-review-token': target.token },
        timeout: 5000,
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

function snapshot(document) {
  const file = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  const diagnostics = vscode.languages.getDiagnostics(document.uri).map((item) => ({
    severity: ['error', 'warning', 'info', 'hint'][item.severity] || 'info',
    line: item.range.start.line + 1,
    column: item.range.start.character + 1,
    message: item.message,
    source: item.source || '',
  }));
  return {
    type: 'buffer', file, absPath: document.uri.fsPath.replace(/\\/g, '/'),
    languageId: document.languageId, version: document.version,
    dirty: document.isDirty, lines: document.getText().split('\n'), diagnostics,
  };
}

function connect(overrides = {}) {
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  const port = overrides.port || config.get('port', 64972);
  const token = overrides.token || config.get('token', '');
  log(`connect port=${port} tokenLen=${token.length} workspace=${vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || ''}`);
  if (!token) {
    vscode.window.showWarningMessage('CI Review Bridge: token 未配置（DSH 面板 → 复制桥接参数 → 填入设置）');
    return;
  }
  target = { port, token };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  post(JSON.stringify({ type: 'hello', workspaceRoot: root.replace(/\\/g, '/'), vscodeVersion: vscode.version, extensionVersion: '0.1.2' }))
    .then((ok) => log(`hello accepted=${ok}`));
  const editor = vscode.window.activeTextEditor;
  if (editor) post(JSON.stringify(snapshot(editor.document))).then((ok) => log(`buffer accepted=${ok}`));
  vscode.window.showInformationMessage(`CI Review Bridge: connecting to 127.0.0.1:${port}`);
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
    if (vscode.window.activeTextEditor?.document === event.document) post(JSON.stringify(snapshot(event.document)));
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (target && editor) post(JSON.stringify(snapshot(editor.document)));
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    const editor = vscode.window.activeTextEditor;
    if (target && editor) post(JSON.stringify(snapshot(editor.document)));
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('ciReviewBridge')) connect();
  }));
  // Prefer the live discovery file written by the DSH Host on every start; fall
  // back to user settings for manually configured hosts.
  const discovery = readDiscovery();
  log(`discovery ${discovery ? `port=${discovery.port}` : 'missing'}`);
  if (discovery) connect({ port: discovery.port, token: discovery.token });
  else connect();
}

function deactivate() {
  target = null;
  log('deactivate');
}

module.exports = { activate, deactivate };
