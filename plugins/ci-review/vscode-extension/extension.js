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
    /* DSH 未运行或端口变化时静默重试（下一次编辑会再次推送） */
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

function connect() {
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  const port = config.get('port', 64972);
  const token = config.get('token', '');
  target = { url: `http://127.0.0.1:${port}/dsh-ci-review/api/vscode/push`, token };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  push({ type: 'hello', workspaceRoot: root.replace(/\\/g, '/'), vscodeVersion: vscode.version, extensionVersion: '0.1.0' });
  const editor = vscode.window.activeTextEditor;
  if (editor) push(snapshot(editor.document));
  vscode.window.showInformationMessage(`CI Review Bridge: connected to 127.0.0.1:${port}`);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('ciReviewBridge.connect', () => connect()));
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
}

function deactivate() {
  target = null;
}

module.exports = { activate, deactivate };
