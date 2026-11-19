# Agent task contract and report specification

This document fixes how the CI review workbench hands work to a **background,
independent-context subagent** and how that work is reported back to the user.
It is the contract the panel and the Host half implement; the report schema is
what the panel renders.

## Why a subagent

The user must keep their own conversation. A fix request is therefore executed
by a child Agent with its own context and its own Session, while the panel is the
single place that explains:

- what is being done now (phase, current file, tool calls),
- what was changed (files, lines, rationale),
- what consequences the change may have (behavior/compat/performance/security),
- which tests will follow and which were actually run,
- what remains open or needs the user's decision.

## 1. Task brief (input)

The panel builds this from an annotation, a review finding, or a free-form
`file:line` selection. All fields are required unless marked optional.

| Field | Meaning |
| --- | --- |
| `taskId` | Host-generated id, stable for the whole run. |
| `projectId` / `root` | Project registration and absolute checkout root. |
| `repo` / `branch` / `headSha` | GitHub repository and the exact base commit the agent starts from. |
| `location` | `{ file, startLine, endLine }` — the target the user clicked. |
| `problem` | One-paragraph statement of the defect or request (from the finding when available). |
| `instruction` | The user's explicit direction, in the user's language. |
| `constraints` | Non-goals, API/format compatibility, style, "do not touch X". |
| `allowedScope` | Files/directories the agent may change; outside means stop and ask. |
| `acceptance` | Commands and expected outcomes (tests, lint, gate). |
| `riskBudget` | `low` (single file, small edit) / `medium` (multi-file, behavior change) / `high` (refactor, data or API change). |
| `worktree` | `prefer` (isolated worktree) or `in-place`; the Host decides what it can honor. |

## 2. Delegation

The Host calls `ctx.subagents.startActivation`:

- `provider`: the installed local provider;
- `cwd`: the project root or its worktree;
- `parent`: the live root Agent the panel is attached to;
- `prompt`: the task brief rendered with the reporting rules below;
- `outputSchema`: the structured report schema (section 3);
- `agentOptions`: the session's current provider/model unless the user overrides.

The activation's `result` promise is the report. The panel polls the child
Session (`sessionQuery` / `subagents.listDescendants`) and shows its phase; the
report is persisted under the project's `.review/ci-review/agent-jobs/<taskId>.json`
so it survives a page refresh.

## 3. Report schema (output, required)

```json
{
  "status": "completed | blocked | failed",
  "summary": "one paragraph in the user's language: what changed and why",
  "changes": [
    {
      "file": "relative/path",
      "locations": ["L120-L134"],
      "summary": "what changed here",
      "rationale": "why this fix addresses the brief",
      "risk": { "level": "low | medium | high", "notes": "what could break" }
    }
  ],
  "consequences": {
    "behavior": "observable behavior change, or 'none'",
    "compatibility": "API/format/migration impact, or 'none'",
    "performance": "expected effect, or 'unknown' with reason",
    "security": "authorization/secret/input-handling effect, or 'none'",
    "userVisible": "what a user may notice"
  },
  "tests": {
    "planned": ["command + purpose"],
    "executed": [{ "command": "…", "exitCode": 0, "summary": "…" }],
    "notRun": [{ "command": "…", "reason": "…" }]
  },
  "verification": {
    "reviewGate": "pass | block | needs-human | not-run",
    "findings": ["fingerprints addressed by this change"]
  },
  "unresolved": ["open questions or items deliberately left out"],
  "nextSteps": ["what the user or a follow-up run should do next"],
  "diffStats": { "files": 1, "insertions": 12, "deletions": 3 },
  "confidence": "low | medium | high"
}
```

Rules:

- Never report `completed` without listing `changes`, `consequences` and
  `tests`. An empty `tests.executed` requires at least one `tests.notRun` entry
  with a reason.
- `blocked` must include the exact decision or information the agent needs.
- A change outside `allowedScope` is a `blocked` result, not a silent edit.
- The panel shows the original `instruction` next to the report so the user can
  judge whether the result matches the ask.

## 4. Panel phases (what the user sees)

| Phase | Shown |
| --- | --- |
| `queued` | Task card with the brief, target location, risk budget, "waiting for an agent slot". |
| `running` | Current file, files touched so far (`git diff --stat`), last N tool-call titles, elapsed time. Actions: open child Session, interrupt. |
| `report` | Changes table (file/lines/summary/risk), consequences list with warning tone for medium/high risk, test plan and executed/not-run split, unresolved list, next steps. Actions: view diff, open file, run gate again, ask follow-up, revert. |
| `failed` | Error summary + log link + retry. |
| `blocked` | The exact question, with "answer in the child Session" and "cancel". |

Every phase states **who is doing what** and **what happens next**; no phase is
only a spinner.

## 5. Safety and rollback (non-negotiable)

1. Record `git rev-parse HEAD` and `git status --porcelain` before the agent
   starts; refuse to start on a dirty checkout unless the user chooses
   "include uncommitted changes".
2. Prefer an isolated worktree for `riskBudget != low`; the user's working tree is
   never edited without an explicit in-place choice.
3. Never commit, push, merge, approve or resolve review threads from the agent
   task. Those remain explicit user actions in the panel.
4. The report must be written before the working tree state is considered final;
   the panel offers "view diff" and "revert these files" (restored to the
   recorded baseline) on the same card.
5. Anything outside `allowedScope`, any destructive operation (delete/rename
   large areas, dependency or config changes), and any secret/credential touch
   stops the task as `blocked` and asks the user.

## 6. Verification follow-up

After a `completed` report the panel automatically:

1. runs the project's configured gate commands (`review gate` / tests) in a
   background job and shows exit codes;
2. refreshes the GitHub checks for the branch if the change was pushed by the
   user;
3. marks the originating annotation/finding as `addressed` only when the gate
   and the report both agree; otherwise `needs-review`.
