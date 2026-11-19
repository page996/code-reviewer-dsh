const vscode = require('vscode');

let socket = null;

function send(message) {
  try {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  } catch {
    /* ignore */
  }
}

function snapshot(document) {
  const file = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  const text = document.getText();
  const lines = text.split('\n');
  const diagnostics = vscode.languages.getDiagnostics(document.uri).map((item) => ({
    severity: ['error', 'warning', 'info', 'hint'][item.severity] || 'info',
    line: item.range.start.line + 1,
    column: item.range.start.character + 1,
    message: item.message,
    source: item.source || '',
  }));
  return { type: 'buffer', file, languageId: document.languageId, version: document.version, dirty: document.isDirty, lines, diagnostics };
}

function connect(context) {
  const config = vscode.workspace.getConfiguration('ciReviewBridge');
  const port = config.get('port', 64972);
  const token = config.get('token', '');
  try { socket?.close(); } catch { /* ignore */ }
  socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-ci-review/vscode?token=${encodeURIComponent(token)}`);
  socket.addEventListener('open', () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    send({ type: 'hello', workspaceRoot: root.replace(/\\/g, '/'), vscodeVersion: vscode.version, extensionVersion: '0.1.0' });
    const editor = vscode.window.activeTextEditor;
    if (editor) send(snapshot(editor.document));
    vscode.window.showInformationMessage('CI Review Bridge: connected');
  });
  socket.addEventListener('close', () => vscode.window.showWarningMessage('CI Review Bridge: disconnected'));
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('ciReviewBridge.connect', () => connect(context)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (vscode.window.activeTextEditor?.document === event.document) send(snapshot(event.document));
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) send(snapshot(editor.document));
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) send(snapshot(editor.document));
  }));
}

function deactivate() {
  try { socket?.close(); } catch { /* ignore */ }
}

module.exports = { activate, deactivate };
