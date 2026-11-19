# CI review workbench

A DSH panel that answers two questions for every project in your workspace:

1. **What is happening now?** — branch, uncommitted changes, the open pull request,
   per-check progress, recent Actions runs, local review runs (`.review/runs`) and
   the DSH sessions recorded for this project.
2. **What can you do next?** — refresh, open the PR / repository / Actions, create a
   PR, copy the branch. Every action states why it is unavailable when it is
   disabled, instead of silently doing nothing.

The panel is global: click the **CI review** icon in the left sidebar and pick a
project on the left.

## Data sources

| Source | Used for | Requires |
| --- | --- | --- |
| `workspaceRegistry` (Host) | project discovery | none |
| local Git (`git -C <root> …`) | branch, HEAD, dirty count, remote | project is a Git checkout |
| GitHub REST (Host side) | PR, checks, reviews, Actions runs | `GITHUB_TOKEN`/`GH_TOKEN` or a host `git credential` entry for `github.com` |
| `.review/runs/*` | local review verdict and counts | code-reviewer-dsh runs in the project |
| `sessionQuery` (Host) | sessions recorded under the project root | none |

The GitHub token never reaches the browser: the Host reads it, calls the API and
returns a normalized snapshot. The panel authenticates to the Host with a
per-process token injected into the page and a same-origin check.

## Configure extra projects

Projects are discovered from your DSH workspaces automatically. To include a
checkout that is not a DSH workspace, add it in Plugin Manager → CI review
workbench → **config**:

```yaml
projects:
  - name: my-service
    root: 'C:/work/my-service'
```

## Current status (v0.1.0, read-only)

- Read-only snapshot: project/git state, PR, checks, recent Actions runs, local
  review runs, sessions.
- Polling every 15 s while the panel is open; manual refresh forces a rebuild.
- No GitHub write actions yet (rerun failed checks, submit review, merge) and no
  annotations/agent handoff yet: those are the next phases and will reuse the
  same snapshot + action contract so that every button is backed by one Host
  method an agent tool can call too.

## Limitations

- GitHub Enterprise hosts and non-GitHub forges are not mapped yet (GitHub.com
  only).
- Check logs / job-step detail are not fetched; each check links to its GitHub
  page.
- Step-level progress and rerun need write permissions; the panel shows the
  reason when the token or repository permission is missing.
- The panel caches snapshots for `refreshSeconds` (default 20 s).
