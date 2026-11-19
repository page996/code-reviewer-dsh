# ci-review VS Code bridge (L3) — protocol draft

Goal: let the DSH ci-review panel show the **real, unsaved VS Code buffer** (and
LSP diagnostics) for the file a review card points at, without turning the panel
into an IDE. The extension is a thin bridge: VS Code owns editing, LSP and
diagnostics; the panel renders a read-only projection.

## Transport

- Host: DSH plugin serves `POST /api/vscode/push` (per-process token, same
  origin policy as the other routes). The extension POSTs JSON snapshots with
  `?token=<panel token>`; the Host caches them in `snapshot.vscode.buffers` and
  the panel renders the projection. WebSocket streaming is optional future work;
  the current implemented transport is this HTTP push (simpler, Windows/VS Code
  friendly, no extra dependency).
- The extension reads `ciReviewBridge.port` / `ciReviewBridge.token` settings and
  runs `CI Review: Connect to DSH panel`.

## Messages (extension → host)

```json
{ "type": "buffer", "file": "plugins/ci-review/client.js", "languageId": "javascript",
  "version": 42, "dirty": true, "lines": ["..."], "cursor": {"line": 12, "column": 3},
  "selection": {"startLine": 10, "endLine": 18} }
{ "type": "diagnostics", "file": "...", "items": [
  { "severity": "error|warning|info", "line": 12, "column": 3, "message": "...", "source": "eslint" } ] }
{ "type": "hello", "workspaceRoot": "E:/proj", "vscodeVersion": "1.x", "extensionVersion": "0.1.0" }
```

## Host → panel shape

`snapshot.vscode = { connected, workspaceRoot, files: { [file]: { version, dirty, lines, cursor, selection, diagnostics } } }`
The panel uses `files[card.file].lines` when present and marks `dirty: true` so
the user knows the projection differs from disk.

## Compatibility rules

- Paths are workspace-relative POSIX strings; the host maps to the card's file.
- If the workspace root differs from the registered project root, the panel shows
  "VS Code 打开的是另一个工作区" and falls back to L1.
- Large files are sliced around the card lines (max 2,000 lines) before push.
- Extension absence is never an error: panel states which layers are active.

## Install (manual, user action)

A packaged VSIX is committed next to this README:

```powershell
code --install-extension E:/dsh-new-1/code-reviewer-dsh/plugins/ci-review/vscode-extension/ci-review-bridge-0.1.0.vsix
```

Then in VS Code:

1. Settings → `CI Review Bridge` → set `port` (the DSH web port, e.g. 64972) and
   `token` (the DSH panel token, `window.__DSH_CI_REVIEW_TOKEN__`).
2. Command Palette → `CI Review: Connect to DSH panel`.
3. Keep the reviewed file open; edits/selection changes are pushed to the panel.

Installation is reversible: `code --uninstall-extension local.ci-review-bridge`.

