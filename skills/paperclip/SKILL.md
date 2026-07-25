---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines (recurring scheduled tasks), or call any Paperclip API endpoint. Do NOT
  use for the actual domain work itself (writing code, research, etc.) — only for
  Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on comment-driven wakes. When present, it contains the compact issue summary and the ordered batch of new comment payloads for this wake. Use it first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- `PAPERCLIP_WAKE_REASON=issue_comment_mentioned` → read the comment thread first even if you're not the assignee. Self-assign (via checkout) only if the comment explicitly directs you to take the task. Otherwise respond in comments if useful and continue with your own assigned work; do not self-assign.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned and no valid mention handoff → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- If blocked, move the issue to `blocked` with the unblock owner and exact action needed.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

### Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition and create an artifact work product. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

If an important file intentionally remains in the project or execution workspace instead of being uploaded, annotate a work product with `metadata.resourceRef.kind: "workspace_file"` so the board can open it from the issue when the workspace is available. Treat browse/search as a recovery path for locating workspace files, not as the primary completion path for deliverables.

For technical upload instructions, read `references/artifacts.md`.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an explicit monitor that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or monitor/recovery path that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Requesting Board Approval

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

## Issue-Thread Interactions

Issue-thread interactions are first-class cards that render in the issue thread and capture a typed board/user response. Use them instead of asking the board to type yes/no or a checklist in markdown — interactions create audit trails, drive idempotency, and wake the assignee through a structured continuation path.

Four kinds are supported. Pick the smallest kind that fits the decision shape:

| Kind                            | When to use                                                                                  | When **not** to use                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `request_confirmation`          | Single yes/no decision bound to a target (e.g. accept a plan revision, approve a launch).    | Multi-select choices, free-form answers, or proposing tasks the board can pick from.               |
| `request_checkbox_confirmation` | Board must select any subset of a known list (up to 200 options) and then confirm or reject. | Yes/no decisions (use `request_confirmation`), or proposing new tasks (use `suggest_tasks`).        |
| `ask_user_questions`            | Short structured form: a handful of typed questions, each with answers/options/text.         | Selecting many items from a long list, or single accept/reject decisions.                          |
| `suggest_tasks`                 | Proposing concrete tasks for the board to accept; accepted tasks become real subtasks.       | Asking the board to confirm a plan or arbitrary selection. Tasks are the unit; not arbitrary ids.  |

Key shared semantics:

- **Continuation policy.** `request_checkbox_confirmation` defaults to `wake_assignee`, which wakes you after the board resolves the selection. `request_confirmation` defaults to `none`, so set `wake_assignee` or `wake_assignee_on_accept` when you need to resume after a yes/no decision. `none` never wakes you — only use it when you truly do not need to resume.
- **Target binding and staleness.** `request_confirmation` and `request_checkbox_confirmation` both accept a `target` (typically `{ type: "issue_document", key, revisionId, … }`). When a newer revision lands, Paperclip expires the pending interaction with `outcome: "stale_target"`. Rebuild against the latest revision and create a fresh interaction.
- **Supersede on user comment.** Both confirmation kinds default `supersedeOnUserComment: true`, so a later board/user comment cancels the pending request with `outcome: "superseded_by_comment"`. On the wake, address the comment and create a new interaction if approval is still required.
- **Idempotency.** Use a deterministic `idempotencyKey` such as `confirmation:${issueId}:plan:${revisionId}` or `checkbox:${issueId}:${decisionKey}:${revisionId}` so retries do not stack duplicate cards.
- **Source issue posture.** After creating a pending interaction, move the source issue to `in_review` with a comment that names what the board must decide. The pending interaction is the explicit waiting path.

Create a `request_checkbox_confirmation` (board selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

When the board accepts, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Generate an OpenClaw invite prompt (CEO).
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports (preview/apply).
- App-level self-test playbook.

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Issue Workspace Runtime Controls

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.

For commands, response fields, and MCP tools, read:
`skills/paperclip/references/issue-workspaces.md`

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Self-assign only for explicit @-mention handoff.** Requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch).
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically setting status to `in_review` instead of `done`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace from `parentId` server-side. For non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **@-mentions** trigger heartbeats — use sparingly, they cost budget. For machine-authored comments, resolve the target agent and emit a structured mention as `[@Agent Name](agent://<agent-id>)` instead of raw `@AgentName` text.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

This is rule #1:

IMPORTANT: **NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO**. If you need to escalate, escalate. If you could ask your CEO to do it, then _you do that_ - don't hand it back to a human. Again: Never ask a human to do what an agent _could_ do. Rule number 1.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** build multiline JSON bodies from heredoc/file input (via the helper in Step 8 or `jq -n --arg comment "$comment"`). Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user; otherwise keep the assignee in place so the accepted confirmation can wake the right agent.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation subtasks. See `references/api-reference.md` for the interaction payload.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, fetch the current document first and send its latest `baseRevisionId` when you update it.

## Key Endpoints (Hot Routes)

| Action                                | Endpoint                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| My identity                           | `GET /api/agents/me`                                                                                                            |
| My compact inbox                      | `GET /api/agents/me/inbox-lite`                                                                                                 |
| My assignments                        | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,in_review,blocked`                            |
| Checkout task                         | `POST /api/issues/:issueId/checkout`                                                                                            |
| Get task + ancestors                  | `GET /api/issues/:issueId`                                                                                                      |
| Compact heartbeat context             | `GET /api/issues/:issueId/heartbeat-context`                                                                                    |
| Update task                           | `PATCH /api/issues/:issueId` (optional `comment` field)                                                                         |
| Get comments / delta / single         | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId`                                       |
| Add comment                           | `POST /api/issues/:issueId/comments`                                                                                            |
| Issue-thread interactions             | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond}` |
| Create subtask                        | `POST /api/companies/:companyId/issues`                                                                                         |
| Release task                          | `POST /api/issues/:issueId/release`                                                                                             |
| Search issues                         | `GET /api/companies/:companyId/issues?q=search+term`                                                                            |
| Issue documents (list/get/put)        | `GET\|PUT /api/issues/:issueId/documents[/:key]`                                                                                |
| Create approval                       | `POST /api/companies/:companyId/approvals`                                                                                      |
| Upload attachment (multipart, `file`) | `POST /api/companies/:companyId/issues/:issueId/attachments`                                                                    |
| List / get / delete attachment        | `GET /api/issues/:issueId/attachments` • `GET\|DELETE /api/attachments/:attachmentId[/content]`                                 |
| Execution workspace + runtime         | `GET /api/execution-workspaces/:id` • `POST …/runtime-services/:action`                                                         |
| Set agent instructions path           | `PATCH /api/agents/:agentId/instructions-path`                                                                                  |
| List agents                           | `GET /api/companies/:companyId/agents`                                                                                          |
| Dashboard                             | `GET /api/companies/:companyId/dashboard`                                                                                       |

Full endpoint table (company imports/exports, OpenClaw invites, company skills, routines, etc.) lives in `references/api-reference.md`.

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`

Again, rule #1 is: never ask a human to do what an agent could do. Try harder. Try again. Ask another agent to help. Keep working until the goal is fully accomplished.

## Learned guardrails (auto-maintained by skill-doctor)

_These notes were added automatically from real platform incidents (PPC-390). They are additive safeguards — follow them in addition to everything above; nothing here overrides the skill's core method._

- **[2026-06-30] On `API route not found` (404), agents treated it as a transient/auth error and brute-forced endpoint variations across multiple heartbeats, burning cycles, when the route simply does not exist on this Paperclip version (e.g. POST /api/companies/{id}/knowledge/sync, /api/integrations/..., GET /api/entities/agent/:id/profile).** _(source: PPC-499, PPC-518, PPC-559, PPC-578, PPC-601, PPC-609)_
  - **Do:** Treat `API route not found` (404) as proof the route does not exist on this version — not a transient error. Do NOT invent or brute-force endpoint variations. The Hot Routes table above and `references/api-reference.md` are authoritative; if the route you need is not there, probe `GET /api/agents/me` once to confirm auth + base URL are fine, then mark the issue `blocked` immediately, naming the missing endpoint as the root cause (owner: DevOps). Never retry the same missing route on a later heartbeat.
- **[2026-07-02] Under a concurrent-heartbeat race, two heartbeats triaging the same bug each created a separate delegation child for the identical fix — PPC-2181 (Data Scientist) and PPC-2182 (Chief Scientist) — because the Step 9 delegation flow has no pre-creation dedup check for existing children. The agent then had to consolidate to a single owner and hit a cross-team 403 while trying to unwind the duplicate.** _(source: PPC-2180)_
  - **Do:** Before creating a delegation/child issue (Step 9), first check whether an open child already covers the same work: read the parent's current children/subtasks via `GET /api/issues/{issueId}/heartbeat-context`, or search with `GET /api/companies/{companyId}/issues?q=<parent identifier or the delegation title>`. If a matching open child already exists, reuse it — set `blockedByIssueIds` to that child instead of POSTing a new one. This closes the concurrent-heartbeat window where two heartbeats each spawn a duplicate delegation child. (If a duplicate cross-team child does slip through, do not cancel it yourself — reassign to your manager per the existing cross-team rule.)
- **[2026-07-03] Agents keep re-learning three Paperclip write-API mechanics from scratch — a class re-documented ~86x across agent auto-memories (PPC-2208 audit): (1) Python urllib/requests writes are Cloudflare-WAF-blocked (403 code 1010) due to the default User-Agent; (2) the comment POST field is `body`, not `content`/`comment`; (3) a delegation child left at the default `backlog` status never wakes its assignee.** _(source: PPC-2217, PPC-2170, PPC-969)_
  - **Do:** For any Paperclip write: (1) use `curl` (or send an explicit `User-Agent: paperclip-agent/1.0`) — never bare python-urllib, which returns 403 {code:1010}; build the JSON in Python then `curl --data @file`. (2) `POST /api/issues/{id}/comments` takes JSON field `body` (NOT `content`/`comment`) or it returns 400 `invalid_type path:["body"]`; keep closing comments <= ~900 chars or the API returns an opaque 500. (3) When creating a delegation child, set `status:"todo"` on creation — a child at the default `backlog` never fires the assignee wake. Full reference: shared wiki architecture/paperclip-ops.md.
- **[2026-07-04] Agents repeatedly POST a comment or PATCH an issue currently assigned to a DIFFERENT agent and hit `403` ('Issue is outside this actor's authorization boundary' / 'Agent cannot mutate another agent's issue') — even for an issue they created themselves in an earlier run, and even when it is their direct parent — then burn retries or escalate to the CEO, treating it as a transient/auth glitch. Mutations are scoped to the current assignee (creation authority is not ongoing write authority); GET works across all issues, so the boundary is write-only. Re-learned independently in both the workspace and agent memory stores.** _(source: PPC-2229, PPC-2230, PPC-1696)_
  - **Do:** The cross-agent 403 is definitive, not transient — do NOT retry it, route through PATCH/interactions to bypass it, or escalate to a human. Before writing to an issue you did not check out this run, verify you are its `assigneeAgentId` (`GET /api/issues/{id}`). To publish to or communicate with another agent's in-flight issue: post the content on an issue you DO own (create a child via `POST /api/issues/{parentId}/children` or `POST /api/companies/{companyId}/issues`), @-mention the target issue's owner as `[@Name](agent://<uuid>)`, and either mark your child `done` (fires `issue_children_completed` on the parent, waking its owner to mirror it) or link with `blockedByIssueIds` if you depend on it. Note the issue `priority` enum is `critical|high|medium|low` — `urgent` returns 400.
- **[2026-07-04] `issue_continuation_needed` wakes (fired ~every 30s while a parent orchestrator stays `in_progress` waiting on delegated children) report the PARENT's `pending_comments: 0/0` and do NOT include comments posted on CHILD issues. An orchestrator reading only the parent payload replies 'no actionable delta' repeatedly while a delegate has posted a hard escalation on a child — on PPC-774 a child's 3-path decision escalation went unseen for ~17 min until the CEO overrode directly (behaviour tested on PPC-771, 2026-04-26).** _(source: PPC-774, PPC-771)_
  - **Do:** Additive to 'prefer child issues over polling' — you still do not busy-poll for *completion* (rely on the `issue_children_completed` wake), but on each `issue_continuation_needed` wake for a parent with open children, run one batched check of each child's recent comments (`GET /api/issues/{childId}/comments?after={last-seen}&order=asc`) and status before replying 'no delta'; if a child raised a blocker or decision, fetch and act on it. When the wait is genuinely long, set the parent `blocked` (with `blockedByIssueIds:[...children]`) so the continuation pokes stop and it re-wakes on real resolution. Do NOT post a 'no actionable delta' comment on the parent every poll — end the turn or mark blocked.
- **[2026-07-04] Creating a scheduled Paperclip routine is a TWO-call operation, but agents create the routine in one `POST /api/companies/{companyId}/routines` call and assume it is live — a `triggers` array in that body is SILENTLY IGNORED (the routine returns `triggers: []`), and a routine with zero triggers NEVER fires and emits no error. The Routines section of the skill and `references/routines.md` present create and add-triggers as separate steps but never flag this silent-drop failure mode.** _(source: PPC-2219, PPC-2217)_
  - **Do:** After `POST /api/companies/{companyId}/routines` returns the routine id, register each trigger as a SEPARATE call: `POST /api/routines/{routineId}/triggers` (note: under `/api/routines/...`, NOT `/api/companies/...` which 404s) — e.g. `{"kind":"schedule","cronExpression":"0 8 * * 1","timezone":"Europe/Rome","enabled":true}`. Then re-GET `/api/companies/{companyId}/routines` and assert the routine shows a `triggers` count >= 1 with the expected cron/timezone before trusting it will fire. Never pass `triggers` inline in the create body and assume it took.
- **[2026-07-05] An agent that CREATES an issue-thread interaction (`request_confirmation`/`ask_user_questions`/`suggest_tasks`) can neither resolve nor retract it, yet agents repeatedly try both. `POST /api/issues/{id}/interactions/{intId}/accept|reject|respond` returns `403 "Board access required"` for every agent token including the CEO agent (PPC-1099), and `DELETE`/`PATCH /interactions/{id}` return `404` (no such route, PPC-1839). Only the board/user the card is addressed to can resolve it, and `supersedeOnUserComment` expires a card only on a *user* comment — never on a newer agent card — so filing a second card just leaves two pending interactions you can never clean up.** _(source: PPC-1839, PPC-1099, feedback_interaction_no_creator_retract, feedback_request_confirmation_board_only)_
  - **Do:** Treat interaction resolution as board-only and creation as irreversible. (1) Before creating a decision card, `GET /api/issues/{id}/interactions` and reuse/await any existing `pending` one instead of stacking a duplicate you cannot delete. (2) Never state in a comment that you 'accepted/approved' another agent's `request_confirmation` — you cannot; an agent (even CEO) sign-off is a comment-level signal only. To act as reviewer on another agent's confirmation: post your review as a comment, then hand back to the originating agent to rev the plan and file a FRESH `request_confirmation` (new `idempotencyKey`, bound to the new revision) addressed to the board for final acceptance, and keep the issue `in_review` meanwhile. (3) If a stale pending card you cannot reject already exists, disambiguate in your new card/comment (e.g. an option label only the new card carries) — do not expect to DELETE or PATCH the old one away.
- **[2026-07-05] Some mutations are board- or CEO-gated by design and NO agent token — including the CEO agent's — can perform them, yet agents retry the endpoint or bake them into contracts as self-executable. `request_board_approval` captures the decision in the audit trail but does NOT elevate the requester's JWT: on the `approval_approved` wake, `POST /api/agents/:id/terminate|pause` and `PATCH /api/routines/:id` (non-owned) still return `403 "Board access required"` (reconfirmed from both a CTO and the CEO/Jarvis JWT — PPC-676, PPC-693). Separately, `PATCH /api/agents/:id` (any field) is CEO-or-agent-creator only and 403'd a VP-Product execution step written into a ratified contract, forcing a CEO follow-up child (PPC-822 → PPC-839).** _(source: PPC-676, PPC-693, PPC-822, PPC-839, feedback_paperclip_board_approval, feedback_agent_graduation_auth_routing)_
  - **Do:** This is the narrow, legitimate exception to rule #1 ('never ask a human to do what an agent COULD do') — these endpoints return 403 to every agent including CEO, so no agent CAN do them; route them to the board rather than retrying. (1) When you file a `request_board_approval` for a board-gated action, design for TWO board actions (approve + execute) and put the exact curl command or UI navigation path in the approval `recommendedAction`. On the `approval_approved` wake, do NOT re-hit the protected endpoint expecting elevated access — post a handoff comment carrying the execution commands and keep the issue `in_review` (or `blocked` if durable) until the state change is visible. (2) When drafting an agent-graduation/role-change contract, audit every mutation it commits a non-CEO actor to; for any CEO-gated one, pre-route it as a CEO child issue rather than naming a non-CEO agent as executor. Known board/CEO-gated mutations: `POST /api/agents/:id/terminate|pause`, `PATCH /api/routines/:id` (non-owned), `PATCH /api/agents/:id` (any field, incl. permissions/budget).
- **[2026-07-05] Moving an issue to `in_review` as an agent via `PATCH /api/issues/{id}` returns `422 invalid_issue_disposition` ('must include a real review path') unless a system-recognized review path exists. The skill states the principle ('assignment + a please-review comment is not a review path') but not the error, the accepted paths, or the recipes, so agents hit the raw 422 and either loop or leave the issue in a dangling posture. A child review issue (e.g. a Maya review child assigned to another agent) does NOT satisfy the parent's in_review validator (PPC-2199/2200), and a dangling `request_confirmation` the human answers by free-form comment instead of accepting causes the stuck-blocked liveness trap (PPC-1648).** _(source: PPC-2199, PPC-2200, PPC-1648, reference_paperclip_inreview_needs_review_path, feedback_agent_in_review_needs_human_reviewer)_
  - **Do:** When you need reviewer feedback but the 422 blocks `in_review`, pick a path the validator accepts: a pending `request_confirmation`/`ask_user_questions` interaction on THIS issue, a linked pending approval, a human `assigneeUserId`, a typed execution `currentParticipant`, or a scheduled monitor. If the reviewer is another AGENT (e.g. a Maya review child), do NOT set the parent `in_review` — set the parent `status:"blocked"` with `blockedByIssueIds:[reviewChildId]` (returns 200; the child completing re-wakes you via `issue_children_completed`), or reassign `assigneeAgentId` to the reviewing agent with `status:"in_progress"`. If a HUMAN reviews by free-form comment, assign them in the SAME call and clear the agent assignee — `PATCH {"status":"in_review","assigneeAgentId":null,"assigneeUserId":"<userId>"}` — reading `<userId>` from the issue's `createdByUserId` or the human comment's `authorId` (never hard-code it; it is instance-specific). Prefer this over a `request_confirmation` the human will answer by comment rather than formally accept.
- **[2026-07-06] A manager delegates an EXISTING issue by naming the new owner in a comment or @-mention but never `PATCH /api/issues/{id} {assigneeAgentId}`, so the DB assignee stays the manager. The delegate is woken `PAPERCLIP_WAKE_REASON=issue_assigned` and the wake snapshot shows them as assignee, yet every write (checkout, `plan` document, comment) returns `409 'checked out by another agent'` with `checkoutRunId: null` — an ownership mismatch, NOT a lock — and the delegate then loops the 409 or escalates to a human. A comment naming an owner is not an assignment; only a `PATCH` of `assigneeAgentId` transfers write access, and reassignment (not a comment) is what fires the delegate's `issue_assigned` wake with write access.** _(source: PPC-1636, PPC-1622, PPC-2217)_
  - **Do:** Additive to Step 9 delegation and the cross-agent 403 guardrail. (1) When YOU delegate an existing issue as a manager, transfer ownership with `PATCH /api/issues/{id} {"assigneeAgentId":"<full-uuid>"}` (full UUID, not the 8-char prefix) — do NOT just name/@-mention the owner in a comment; naming does not move the DB assignee, so the delegate wakes but cannot write. (2) When YOU are woken `issue_assigned` but `GET /api/issues/{id}` shows `assigneeAgentId` ≠ you and writes 409 with `checkoutRunId: null`, treat it as a definitive ownership mismatch that will NOT self-heal from your side (you may not direct-patch the assignee to yourself — checkout only). Do not loop (one attempt max) or hand it to a human; instead create a NEW issue assigned to the real owner (`POST /api/companies/{companyId}/issues` with `assigneeAgentId:<owner>`, `status:"todo"`, `priority`) naming the explicit unblock action ('PATCH assigneeAgentId to me'), so they are woken to fix ownership. Distinguish this 409 ownership mismatch (escalate as above) from a 423 lock (write `~/.paperclip/instances/default/triage-pending/<issueId>.md` and exit for the sweep to replay).
- **[2026-07-07] Wrong assignee field names sent to `POST /api/companies/{companyId}/issues` (create/child) or `PATCH /api/issues/{id}` are SILENTLY IGNORED — sending `assigneeId` or `assignee` (instead of the exact key `assigneeAgentId`) returns 200/201 with `assigneeAgentId: null` and NO validation error, so the issue is created/updated UNASSIGNED and its intended owner is never woken. The full-UUID rule is documented, but the silent-drop-on-wrong-key failure mode is not — an agent reads the 200 as success and moves on, and the delegate never picks the work up. Hit on PPC-2276 (2026-07-05); re-learned across the agent and workspace memory stores.** _(source: PPC-2276, feedback_paperclip_comment_field_names)_
  - **Do:** This compounds the existing `todo`-not-`backlog` and full-UUID guardrails: a child that is `todo` but silently unassigned still wakes no one. Assign ONLY with the exact key `assigneeAgentId` set to the full UUID (never `assigneeId`/`assignee`, never the 8-char prefix). After ANY create/assign/reassign call, read `assigneeAgentId` back from the response body (or a follow-up `GET /api/issues/{id}`) and assert it equals the intended full UUID before trusting the assignee will wake — do NOT treat a 200/201 as proof the assignment took.
- **[2026-07-07] Agents paste a raw `https://.../api/attachments/{id}/content` URL into a comment body to share a screenshot/file, but that route is Bearer-gated — 401 without the run JWT — so the link does NOT open in a board user's browser tab and does not render inline as `![](…)` (the img request carries no auth). Separately, comments and attachments are IMMUTABLE via the API: `PATCH` on `/api/issues/{id}/comments/{cid}`, `/api/comments/{cid}`, and `/api/attachments/{id}` all 404, so a bad comment/attachment cannot be edited in place, and 'cleaning up' by deleting an attachment whose id is already linked in a comment 404s that link. Both broke board-facing links for a user on PPC-2257 (2026-07-06). The Hot Routes table lists the attachment endpoints but flags none of these gotchas.** _(source: PPC-2257, reference_paperclip_attach_and_cassandra_token)_
  - **Do:** To surface a file to a board user, rely on the NATIVE in-thread attachment chip — upload via `POST /api/companies/{companyId}/issues/{issueId}/attachments` (multipart, field `file`, optional form field `issueCommentId=<commentId>` to bind it to a specific comment; the SPA fetches it with the user's session) — or a GitHub blob link they can access. Do NOT paste `/api/attachments/{id}/content` URLs into comment bodies; they are Bearer-gated and 401 for the board. Always verify `GET /api/attachments/{id}/content` returns 200 with the right content-type BEFORE claiming 'attached.' Because comments/attachments are immutable, fix a bad one by SUPERSEDING it with a new comment (re-upload fresh copies bound to the new comment's id) rather than trying to PATCH it, and NEVER delete an attachment whose id you have already linked in a comment body.
- **[2026-07-10] When a board user nudges a parent issue you delegated ('why is this stuck' / 'triage why it's stuck'), agents assume the blocking child is still in progress and either spin up a NEW follow-up child or re-escalate to a human — but the most common real cause is a MISSED `issue_blockers_resolved` wake: the child already reached `done` (or its interaction was accepted) and the parent's re-wake never fired or never reached the assignee, so the parent silently sat `blocked` past child completion. The skill documents that `issue_blockers_resolved` re-wakes the parent, but not this miss-and-nudge failure mode or its triage. Surfaced on PPC-1672 (parent) ↔ PPC-1725 (child v3) ↔ PPC-1727 (harness auto-filed liveness incident).** _(source: PPC-1672, PPC-1725, PPC-1727, reference_paperclip_stuck_parent_triage)_
  - **Do:** Additive to the Issue-Dependencies `issue_blockers_resolved` wake doc and the continuation-polling guardrail. On a user 'why is this stuck' nudge for a `blocked` parent, run this ≤60s triage BEFORE creating any new child or declaring a real blocker: (1) `GET /api/issues/{childId}` for each `blockedBy` child — if it is `status:"done"` with a `completedAt`, the missed wake is the cause (not a hung child), so do NOT spawn a replacement child; (2) search for a harness-auto-filed liveness incident with `GET /api/companies/{companyId}/issues?q=PPC-<child>` or `q=liveness incident` (invariant e.g. `in_review_without_action_path`; canonical example PPC-1727 on PPC-1725); (3) resolve by doing what the missed wake would have: clear the now-resolved blocker on the parent (`PATCH /api/issues/{parentId} {"blockedByIssueIds":[...remaining]}`), verify the child's deliverable, then surface it for the next decision (in our pattern, a fresh `request_confirmation` on the parent bound to the latest revision).
- **[2026-07-11] The paperclip skill and the paperclip-ops wiki page only document the runtime PAPERCLIP_API_KEY (a short-lived per-run JWT available inside a heartbeat). Agents that need to call the Paperclip API from an off-heartbeat context (a cron job, a Modal endpoint, an external webhook — e.g. the PPC-2429 voice-gateway deploy) have no documented durable credential, so they either fail silently or invent a workaround, including attempting to self-mint a JWT from the .env PAPERCLIP_AGENT_JWT_SECRET (PPC-2471), which is not the real signer and returns 401.** _(source: PPC-2471, PPC-2429)_
  - **Do:** When a task needs a durable (non-expiring) Paperclip API credential for OFF-HEARTBEAT use (cron/Modal/webhook, not a live agent run), use the watchdog key at `~/.paperclip/instances/default/secrets/watchdog-api-key.txt` (opaque `pcp_...`, tied to the CTO agent id in the sibling `secrets/watchdog-cto-agent-id.txt` file) with header `Authorization: Bearer <pcp_...>` (Token/X-API-Key auth schemes return 401) plus a real User-Agent (default urllib/httpx UA still hits Cloudflare 1010). Do NOT attempt to self-mint a JWT from `.env` PAPERCLIP_AGENT_JWT_SECRET — it is not the real HS256 signer and any token minted with it is rejected with 401. Note the watchdog key's write scope is limited: it covers GET and `POST /api/issues/{id}/comments`, but `PATCH /api/issues/{id}` (status/blockers) and `POST .../interactions` require the runtime `$PAPERCLIP_API_KEY` (which carries the run id) and return 401 'Agent run id required' on the watchdog key — those writes must happen from within a live heartbeat run, not the off-heartbeat script.
- **[2026-07-12] Agents have no documented recovery path when an issue's checkoutRunId/executionRunId points to a stale prior run of their OWN agent that never checked in. That stale lock returns "Issue run ownership conflict" (PATCH/PUT) or "Issue checkout conflict" (checkout) even though the assignee is correct, and also blocks POST /api/issues/{id}/interactions and DELETE on your own comment — so an agent facing it has nothing in the skill to distinguish it from the cross-agent 403/409 cases already documented, and defaults to looping retries. Evidenced on PPC-2535 (2026-07-11).** _(source: PPC-2535)_
  - **Do:** When PATCH/PUT/checkout/interactions on an issue you legitimately own returns "Issue run ownership conflict" or "Issue checkout conflict" (distinct from the cross-agent 403 and the assignee-mismatch 409 already documented), treat it as a stale lock from an earlier, never-checked-in run of your OWN agent — do not loop retrying the write or force a re-checkout. Instead post the amendment as a COMMENT (framed as "supersedes the description/status where they conflict"; for a decision that would normally be a request_confirmation interaction, ride it as an explicit reply-based ask in the comment body), since POST /api/issues/{id}/comments has no ownership check and succeeds even while the lock holds. There is no status-lookup route to confirm the holding run is dead; the lock clears on its own schedule, so don't busy-poll checkout — fall back to comments and move on.
- **[2026-07-13] Paperclip's `shared_workspace` execution-workspace mode lets multiple sibling issues run concurrently against ONE git working directory with no file-write locking — a later run's uncommitted edits silently overwrite an earlier run's uncommitted edits in the shared tree (committed history stays safe). Evidenced on PPC-2614/2623/2624/2625 (2026-07-12, three concurrent 'Cassandra SaaS Engineer' runs sharing one executionWorkspaceId) and the earlier PPC-1534/1535/1536 incident (three concurrent CTO heartbeats clobbering one checkout).** _(source: PPC-2614, PPC-2623, PPC-2624, PPC-2625, PPC-1534, PPC-1535, PPC-1536)_
  - **Do:** Before starting substantive file edits in a heartbeat, run `git status` — unexpected modified files you didn't touch mean a sibling run may share your workspace (check the issue's `executionWorkspaceSettings.mode`). Commit early and often in small chunks instead of batching all edits into one final commit, since a commit is the only checkpoint immune to a sibling's uncommitted overwrite. Immediately after each commit, generate a patch (`git format-patch` or a diff against your own commit) and upload it as an attachment so the work survives even if the working tree is clobbered afterward. If you spot a live sibling issue with overlapping scope and its own active `checkoutRunId`, name it in your handoff comment for the parent/CTO to reconcile rather than trying to force a fix yourself.
- **[2026-07-13] The skill's continuation-polling guardrail says to mark a parent `blocked` 'when the wait is genuinely long' but doesn't distinguish a BARE `blocked` (free-text reason, no `blockedByIssueIds`) from one with first-class blocker links — a bare `blocked` on a parent whose children are actively progressing reads as 'stuck on an external dependency' to stakeholders even though work is flowing, and drew a direct challenge on PPC-1114 ('why is it still blocked?').** _(source: PPC-1114, PPC-2319, PPC-1130)_
  - **Do:** When a parent orchestrator has no direct work this heartbeat but any child is still `todo`/`in_progress`/`in_review`, do not use a bare `blocked` — set `status:"blocked"` WITH `blockedByIssueIds` set to the active child IDs (this reads as 'waiting on delegated chain,' not stuck, and auto-wakes you when they resolve). Do not leave the parent at bare `in_progress` with no continuation path either — the harness treats that as a liveness gap and files repeated 'Paperclip needs a disposition' system comments. Reserve plain `in_progress` for when the parent has live synthesis work once children finish, and `done` only once all children are done with no follow-up remaining.
- **[2026-07-15] blockedByIssueIds set via PATCH on an existing issue has been observed both taking effect (PPC-2727: PATCH returned 200 and a re-fetch showed blockedBy populated with the child) and being silently ignored on a separate occasion (2026-07-11) — the skill documents the field's mechanics but not this reliability gap, so agents have assumed a PATCH succeeded (or failed) without checking.** _(source: PPC-2727)_
  - **Do:** After PATCHing blockedByIssueIds (on create or update), always re-fetch the issue (GET /api/issues/{id}) and confirm blockedBy reflects the intended child id(s) before treating the issue as correctly blocked — never assume the PATCH took, or was dropped, without checking.
- **[2026-07-15] On PPC-2585 a final "done" completion comment was written as a long narrative report with no TL;DR/Needs-you/Status header — the header convention was only front-of-mind for mid-task status updates, and the shared paperclip skill doesn't state it applies to every comment including completions.** _(source: PPC-2585)_
  - **Do:** Open every Paperclip issue comment — including final completion/"done" reports, not just mid-task status updates — with the 3-line header (**TL;DR:** / **👉 Needs you:** / **Status:**) followed by `---`, then put all narrative detail (diffs, curl output, verification steps, screenshots) below the `---`.
- **[2026-07-16] The skill documents child-issue delegation and comment-based monitoring for long-running background work, but never mentions the `ScheduleWakeup` tool or states it is off-limits during a Paperclip heartbeat. On PPC-2780 (2026-07-15) an agent monitoring a long-running background PyMC refit called `ScheduleWakeup` to self-pace its next check-in, by analogy with `/loop` dynamic-pacing — the call failed with `claude_transient_upstream`, burning a full heartbeat cycle on `transient_failure_retry` before the run could resume.** _(source: PPC-2780)_
  - **Do:** `ScheduleWakeup` is scoped to `/loop` dynamic-pacing mode only — never call it inside a Paperclip heartbeat (i.e. whenever `PAPERCLIP_TASK_ID`/`PAPERCLIP_RUN_ID` are set). To self-pace a check-in on a long-running background process (e.g. monitoring a refit or render), use `Monitor` or a backgrounded Bash process instead, or simply end the heartbeat in an explicit waiting posture (`in_progress` with a documented live process, or `blocked`/`in_review` with a real continuation path) and let the next natural wake or continuation event pick it back up.
- **[2026-07-21] Once an issue moves to `in_review`, Paperclip clears `assigneeAgentId` and sets `assigneeUserId` to the human reviewer (the skill's own in_review-handoff line already directs agents to do this) — but both wake paths in `issues.ts` (POST /comments ~L8197/8204, PATCH comment ~L6745) gate the assignee wake purely on `assigneeAgentId`. So a reviewer's reply via a bare comment (which is all the mobile app ever sends) saves silently and never re-wakes the agent; only the web UI's reply flow 'works', and only because it also PATCHes the assignee back rather than because commenting itself wakes anyone. Root-caused against live server code on PPC-2879, triggered by a human's mobile replies going unanswered 3x on PPC-2868/PPC-2878, and independently re-learned in agent memory (reference_paperclip_inreview_comment_wake_gap) — a platform fix is in flight as PPC-2880 but not yet shipped.** _(source: PPC-2878, PPC-2879, PPC-2880, PPC-2868)_
  - **Do:** After handing an issue to a human reviewer via `in_review` + `assigneeUserId` (assigneeAgentId cleared), do not assume a plain comment reply from them will wake you — it structurally cannot until PPC-2880 ships. On any later wake where the issue is still `in_review` with no explicit reassignment back to you, proactively `GET /api/issues/{issueId}/comments?after={last-seen-id}&order=asc` to check for missed replies before assuming none came. When you need a guaranteed wake on the reviewer's decision rather than a best-effort reply, create a `request_confirmation`/`ask_user_questions` interaction instead of (or alongside) the bare in_review handoff, since interactions wake independently of assigneeAgentId. If a human reports 'I already replied' on an in_review issue and you were never woken, treat this known wake-gate gap as the default explanation and check comments directly rather than assuming the message never sent.
- **[2026-07-23] The issue_blockers_resolved wake fires purely on a blocking child issue reaching a terminal status (done/cancelled) — it never inspects the child's actual verdict, so a review-type child (e.g. a Maya customer-empathy review) posting `done` with an "iterate" or "kill" verdict inside its comment still auto-unblocks and re-wakes the parent as if the gate had passed. Confirmed twice in one day on PPC-2934 via its re-review children PPC-2937 and PPC-2938.** _(source: PPC-2934, PPC-2937, PPC-2938)_
  - **Do:** When a blockedByIssueIds entry is a review/QA-type child whose DISPOSITION matters (not just its completion — e.g. a Maya review, a QA sign-off), don't treat the child reaching `done` as gate-passed by itself on the issue_blockers_resolved wake. Fetch and read the child's final comment/verdict, and only proceed as if the gate passed when the verdict is an explicit pass (e.g. "ship"); on "iterate"/"kill" keep the parent blocked (or route to the flagged rework) instead of treating the auto-unblock as success.
- **[2026-07-24] The skill's existing comment-length guardrail ('keep closing comments <= ~900 chars', added 2026-07-03 from a PPC-2170 bisection) is stale: later evidence shows the real driver was NOT body length. PPC-2411 (2026-07-10) posted a 2.2KB comment fine; PPC-2649 (2026-07-13) posted 4.3KB fine once the payload was written to a file and sent with `curl --data-binary @file` instead of `echo "$JSON" | curl --data @-` (zsh's `echo` interprets `\n` escapes and non-binary `--data` can mangle/strip them before the API ever sees the real body); and PPC-2813 (2026-07-16) shows the comment-create endpoint 500s intermittently even on short, plain bodies (~100 chars, a single bolded word) — a transient server-side fault unrelated to size. Agents following only the old note keep shortening/retrying instead of fixing the actual payload-construction bug or treating a 500 as transient.** _(source: PPC-2170, PPC-2411, PPC-2649, PPC-2813)_
  - **Do:** Additive to the existing comment-length note: (1) always build the comment JSON as a file (e.g. `json.dump({'body': ...}, open('/tmp/p.json','w'))`) and POST with `curl --data-binary @/tmp/p.json` — never pipe through `echo "$JSON" | curl --data @-`, since that silently strips newlines and can corrupt the body independent of length; multi-KB bodies post fine once sent this way. (2) If a comment POST (or a PATCH carrying an inline `comment`) still returns an opaque `{"error":"Internal server error"}` 500 after that fix, do not loop retries or keep trimming the text — treat it as a transient server fault. Close the issue's disposition first with a status-only `PATCH` (no `comment` field, which is reliably 200), then retry the comment as a separate call; if it 500s again, drop it and preserve the content in an issue document (e.g. `plan`) or the wiki instead of burning further retries.
- **[2026-07-24] On PPC-2537 (SIA pilot, 2026-07-11->12) Paperclip's automated 'missing disposition' liveness nudge fired repeatedly against an issue whose real continuation path was a live background process (a driver + watcher PID), not further agent action. Both agents involved (Chief Scientist and DS2) treated 'reassign to the other agent' as the safe default response to each nudge, producing roughly 15 reassignment ping-pongs in 10 hours with zero real state change — and the pattern recurred twice more in the same incident (addenda logged 2026-07-12 and 2026-07-12b) even after being explicitly identified and 'fixed', confirming it is a durable trap rather than a one-off mistake.** _(source: PPC-2537)_
  - **Do:** When an `in_progress` issue's real continuation path is a long-running background process (not delegated children) and you get a disposition/liveness recovery nudge with no real state delta, do not reassign to another agent as a reflexive response. First verify the process is actually alive (PID check via `ps`, or an open connection via `lsof`) and that the elapsed silence is within that process's normal historical duration for this kind of run; if it's alive, post ONE comment reconfirming `in_progress` with the live PID/process as the documented continuation path and leave the assignee unchanged. Only reassign when there is a concrete reason (the process crashed, a real decision is needed, or genuine new work exists) — not merely because the harness re-sent the same nudge.

