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

## Current status (v0.5, review-cards v2.1 residual-risk closure)

- **Review cards**: problems clustered from local review runs + multi-lens agent
  review jobs. Batch grouping is now **decided by an agent** (grouping subagent
  returns logical stages with phase/title/decision prompt/rationale); the panel
  shows the grouping source and flags stale groupings. `phase` ∈
  `core|impact|verification|contract`; low-priority batches are collapsed;
  per-card and per-batch decisions; ignored requires a reason.
- **Multi-verifier voting**: verifying a problem starts N independent verifiers
  (default 3, `ciReview.verifiers`, different stances: contradiction, callers and
  tests, evidence/reproduction, regression history, impact grading). Each vote is
  stored with evidence; majority decides `confirmed|rejected|uncertain`,
  confidence and `gradedSeverity`. Legacy single-verifier records still render.
- **Real coverage**: each batch reports `reviewed`, `excluded` (review-scope
  exclude reasons or agent-declared exclusions) and `unknown` (files without
  review evidence at the current HEAD); the snapshot adds a project-level
  `reviewCoverage` summary (fresh/excluded/unknown files, stale batch counts).
- **HEAD convergence**: `convergence` in the snapshot reports total/stale/unknown/
  fresh batches and the files that need re-review (ordered by severity). One click
  starts background re-review jobs for the next `ciReview.convergeMaxFiles`
  (default 3) files; a completed job at HEAD supersedes the old one and archives
  it in `superseded.json`.
- **Multi-lens independent review**: one independent subagent per lens reviews a
  selected file and returns structured findings; findings merge into problem
  batches automatically.
- **Fix queue**: approving a problem enqueues it (`.review/ci-review/fix-queue.json`);
  the queue card can start an agent fix, mark fixed or remove.
- **Agent handoff**: background subagent per task (independent context, durable
  session), follow-up messages, child-session conversation view, multi-file
  unified diff, gate runner, worktree annotation creation.
- **Projection reading**: L1 in-panel renderer with selection annotations and
  unsaved-line markers; L2 VS Code deep link; L3 VS Code extension streaming the
  live unsaved buffer + diagnostics, auto-discovery/auto-reconnect
  (`~/.dsh/ci-review-bridge.json`); LSP diagnostics markers.
- **PR**: checks, rerun, inline comments (read/write), review (approve/request
  changes/comment), merge with confirmation; PR files feed the priority file list.
- **Gate / editing**: gate commands from `.review/config.json` (endpoint also
  accepts a temporary override); manual edit with sha256 guard, per-edit backup,
  atomic write and automatic gate after save.
- **Persistence**: panel selection/language/batch/file are remembered; snapshots
  are cached on disk for instant re-entry.

### Agent job supervision (the "it hangs forever" guardrail)

Every model-driven job (grouping, verification votes, review lenses, audit,
autofix) goes through one supervisor, `lib/agent-jobs.mjs` + `startSupervisedJob`
in `index.js`. The contract exists because a single unbounded call used to look
like "the CI model disconnected": a ~200 KB grouping prompt stalled for 20
minutes, and a Host restart left a persisted `running` record that blocked every
retry.

Rules (each enforced by a unit test in `test/ci-review-jobs.test.mjs`):

| Rule | Behaviour |
| --- | --- |
| Prompt budget | per-kind byte budget (group 120 KiB, review 64 KiB, verify 40 KiB, audit 120 KiB, autofix 24 KiB); larger prompts are truncated with an explicit `[ci-review] 提示词超出预算已截断…丢弃 N bytes` marker so the model can answer "insufficient info" instead of hallucinating |
| Deadline | every job stores `timeoutMs` + `deadlineAt` (group 8 min, verify/review 10 min, autofix 12 min, hard cap 30 min) |
| Watchdog | a 20 s interval marks overdue `running` jobs `failed` / `errorCode: timeout` |
| Restart sweep | on `apply()` every persisted `running` job becomes `failed` / `errorCode: interrupted`, so the UI offers retry instead of waiting |
| Dedupe | at most one `running` job per logical `key` (e.g. `group:<head>`, `verify:<problem>:<stance>`, `review:<file>:<lens>`); a second request returns `already-running` |
| Guarded writes | `applyJobUpdate` rejects writes from superseded jobs and from terminal states, so a late callback cannot revive or overwrite the current record |
| Visibility | snapshot `agentJobs` = `{ running, overdue, failed, oldestRunningSeconds, byKind, recentFailures, activeKeys }`; the review-card header shows `子代理：运行 N（最久 Xs）· 失败 M` and a 「清理超时任务」 button calling `POST /api/agent-jobs/reconcile` |

Tuning (all optional):

```jsonc
// <repo>/.review/config.json
{
  "ciReview": {
    "jobTimeoutMs": { "group": 480000, "review": 600000 },
    "promptBudgetBytes": { "group": 122880 }
  }
}
```

Deliberate exception: the user-facing background agent task (`/api/agent-task`)
keeps its own 40-minute AbortController, durable task file and cancel endpoint
because it is parent-delivered and resumable; it is not a "fire-and-forget
review job".

### Grouping / voting / convergence configuration

```jsonc
// <repo>/.review/config.json
{
  "ciReview": {
    "autoFixMinor": false,
    "verifiers": 3,                 // 1..5 verifiers per problem (server-side policy)
    "convergeMaxFiles": 3,          // max files re-reviewed per convergence click (hard cap 10)
    "convergeLenses": ["correctness", "errors", "security"]
  }
}
```

Notes: the verifier count is enforced by the Host (a request body cannot
downgrade it); a verification already running blocks a second start; all-failed
verifications are reported as `failed` (retryable), not `completed`. Convergence
requires a provable HEAD: on a non-git checkout the panel disables auto
re-review. A CLI finding is superseded once the same file has a completed review
job at HEAD (`supersededCliFindings`), otherwise batches would stay "unknown"
forever.

API additions (same-origin, authenticated like the rest of the panel):

| Endpoint | Purpose |
| --- | --- |
| `POST /dsh-ci-review/api/review-problems/verify` | multi-verifier vote (`problem`, optional `verifiers`) |
| `POST /dsh-ci-review/api/review-problems/group` | start the grouping subagent |
| `POST /dsh-ci-review/api/review-job/converge` | plan (`start:false`) or start HEAD re-review |

### Remaining gaps (explicit, post-v2.1)

- Verifiers are independent contexts of the same model, not a heterogeneous
  model ensemble; the vote cap is 5.
- Agent grouping quality depends on the model output; invalid/partial output falls
  back to the heuristic and surfaces an explicit "ungrouped" batch plus a stale
  grouping badge.
- Convergence is user-triggered and capped per click; new commits make batches
  stale again by design, so the loop continues as part of normal review.
- Multi-lens review is triggered per file, not yet auto-expanded to the whole
  project; the completeness audit is an independent agent reverse-audit whose
  quality still depends on the audit prompt.
- Voting-stage auto-fix covers confirmed minors (opt-in via
  `"ciReview": { "autoFixMinor": true }`); larger refactors still need an explicit
  agent task.




- Read-only snapshot: project/git state, PR state, review decision, mergeability,
  unresolved threads, checks with per-check links, recent Actions runs, local
  review runs, sessions.
- **CI process detail**: click a run to expand its jobs and every job's steps
  (status, conclusion, per-job link). Job/step data comes from the GitHub Actions
  REST API; the page shows exactly where a run is stuck or failed.
- **Actions with explained availability**: rerun failed checks, mark ready for
  review, update the branch, merge (squash/merge/rebase, with a confirmation).
  Each button is disabled with the concrete reason when it cannot run
  (not a draft, no failed checks, conflicts, checks not green, no `gh`, …), so the
  panel always explains "what can I do now".
- **Local annotations**: add `file:line` annotations in the panel, mark them
  addressed/reopened, or delete them. They persist in
  `<project>/.review/ci-review/annotations.json`.
- **Background agent handoff**: any annotation can be sent to a background,
  independent-context subagent with an editable instruction. The task card shows
  running/completed/failed/cancelled state, the child session id, the agent's
  structured report (summary, changes with locations and risk, possible
  consequences, planned/executed/not-run tests, unresolved items, next steps),
  and offers cancellation. Tasks persist in
  `<project>/.review/ci-review/tasks/<id>.json`. The agent never commits, pushes,
  merges or approves.
- Data source is reported in the panel: `forge` when the official forge provider
  works, otherwise `REST` for reads plus the authenticated `gh` CLI for actions.
- Polling every 15 s while the panel is open; manual refresh forces a rebuild.

### Client-plugin note

A dynamic client half in this installation cannot `require('styles')` or
`require('console')`; those names are not part of the plain-JavaScript module
table. Render component styles as a `<style>` React element instead. Load failures
of a client half are silent in the page, so verify registration through
`cordis_inspect_query` (`Slots.listSubTree`) after loading a new bundle.

### Windows note: forge-github provider

On Windows with Node 24 the installed `@deepseek-ai/dsh-experimental-forge-github`
provider currently fails every read with:

```text
The command and its arguments cannot contain a line break on Windows without a
shell. ... Invalid value: "query=query { ... }"
```

The provider passes its multi-line GraphQL query as one `gh` spawn argument, and
Node rejects newlines in Windows spawn arguments. This affects DSH's own forge
panel as well. The workbench detects the failure, falls back to the REST reader
for PR/checks/review data, and performs write actions through the authenticated
`gh` CLI (`gh run rerun --failed`, `gh pr ready`, `gh api …/update-branch`,
`gh pr merge`), whose arguments are single-line. Once the provider is fixed, the
panel automatically switches back to `source: forge` and uses its richer state.

`gh` must be reachable from the DSH Host process: either on `PATH` or through the
bundle config `ghCommand` (absolute path to `gh.exe`).

## Configure extra projects