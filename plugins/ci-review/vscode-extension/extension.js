const vscode = require('vscode');

let target = null;

async function push(payload) {
  if (!target) return;
  try {
    await fetch(`${target.url}?token=${encodeURIComponent(target.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* DSH 未运行或端口变化时静默忽略；下次编辑会重试 */
  }
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
    type: 'buffer',
    file,
    languageId: document.languageId,
    version: document.version,
    dirty: document.isDirty,
    lines: document.getText().split('\n'),
    diagnostics,
  };
}

function connect(overrides = {}) {
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  const port = overrides.port || config.get('port', 64972);
  const token = overrides.token || config.get('token', '');
  if (!token) {
    vscode.window.showWarningMessage('CI Review Bridge: 缺少 token（在 DSH 面板点「复制桥接参数」后填入设置，或使用 vscode:// 连接链接）');
    return;
  }
  target = { url: `http://127.0.0.1:${port}/dsh-ci-review/api/vscode/push`, token };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  push({ type: 'hello', workspaceRoot: root.replace(/\\/g, '/'), vscodeVersion: vscode.version, extensionVersion: '0.1.1' });
  const editor = vscode.window.activeTextEditor;
  if (editor) push(snapshot(editor.document));
  vscode.window.showInformationMessage(`CI Review Bridge: connected to 127.0.0.1:${port}`);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('ciReviewBridge.connect', () => connect()));
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path !== '/connect') return;
      const params = new URLSearchParams(uri.query);
      const port = Number(params.get('port')) || undefined;
      const token = params.get('token') || '';
      connect({ port, token });
    },
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (vscode.window.activeTextEditor?.document === event.document) push(snapshot(event.document));
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) push(snapshot(editor.document));
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) push(snapshot(editor.document));
  }));
  // Auto-connect when the bridge settings are already filled in.
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  if (config.get('token', '')) connect();
}

function deactivate() {
  target = null;
}

module.exports = { activate, deactivate };
