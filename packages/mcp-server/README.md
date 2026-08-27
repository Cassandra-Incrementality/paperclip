# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

There is no login tool and no credential ever passes through the tool layer.
The server carries whatever bearer token its caller already holds, and the API's
`actorMiddleware` resolves it (board API key, agent API key, or agent run JWT).

## stdio mode (single caller)

One process, one credential, read from the environment:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

### Getting a key without handling one

`paperclip-mcp-login` runs the board CLI device-code flow: it opens a challenge,
prints an approval URL for a signed-in board user to click, and writes the minted
board API key straight into your MCP client config at mode `0600`. The key value
is never printed, and any legacy `PAPERCLIP_EMAIL` / `PAPERCLIP_PASSWORD` block on
that entry is dropped.

```sh
PAPERCLIP_API_URL=http://localhost:3100 node packages/mcp-server/dist/login.js \
  --config ~/.claude/mcp.json --server paperclip --company <company-uuid>
```

## HTTP mode (many callers)

`paperclip-mcp-http-server` serves StreamableHTTP on `/mcp` for remote clients.
It has **no credential of its own** - every request authenticates itself:

- `PAPERCLIP_API_URL` - Paperclip base URL (required)
- `PAPERCLIP_COMPANY_ID` - optional default company, overridable per request
- `PAPERCLIP_MCP_HTTP_HOST` / `PAPERCLIP_MCP_HTTP_PORT` (or `PORT`) - bind address
- `PAPERCLIP_API_KEY` - **must not be set**; the process refuses to start with one

```sh
pnpm --filter @paperclipai/mcp-server build
PAPERCLIP_API_URL=http://localhost:3100 node packages/mcp-server/dist/http-server.js
```

Each request supplies `Authorization: Bearer <paperclip token>`, and optionally
`X-Paperclip-Company-Id`, `X-Paperclip-Agent-Id`, `X-Paperclip-Run-Id`. A request
with no bearer token is answered `401` with a `WWW-Authenticate` header before any
tool dispatch.

The credential, API client, MCP server, and transport are all built from the
incoming request and discarded with it. There is deliberately no client cache,
no session map, and no fallback identity - a shared `"default"` client is the
defect this transport was written to replace, and `http.test.ts` regression-tests
that two concurrent callers never see each other's identity.

## Tool Surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
