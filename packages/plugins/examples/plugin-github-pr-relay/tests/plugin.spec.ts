import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function makeIssue(overrides: Record<string, unknown> & { id: string; companyId: string }) {
  return {
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test Issue",
    description: null,
    status: "open",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    ...overrides,
  } as any;
}

function makeCommentEvent(body: string, commentId = 42) {
  return {
    action: "created",
    comment: {
      id: commentId,
      body,
      user: { login: "octocat", html_url: "https://github.com/octocat" },
      html_url: "https://github.com/org/repo/pull/7#issuecomment-42",
      created_at: "2026-04-17T12:00:00Z",
    },
    pull_request: {
      number: 7,
      title: "Fix widget alignment",
      html_url: "https://github.com/org/repo/pull/7",
    },
  };
}

function webhookInput(payload: unknown, event = "issue_comment") {
  return {
    endpointKey: "github",
    headers: { "x-github-event": event },
    rawBody: JSON.stringify(payload),
    parsedBody: payload,
    requestId: "req-1",
  };
}

describe("GitHub PR Comment Relay", () => {
  it("health data returns ok", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");
  });

  it("relays a comment mentioning a CAS issue", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    harness.seed({
      issues: [
        makeIssue({ id: "iss-1", companyId: "comp-1", identifier: "CAS-576", title: "GitHub PR Comment Relay" }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const payload = makeCommentEvent("Fixed the bug from CAS-576, also see CAS-999");
    await plugin.definition.onWebhook!(webhookInput(payload));

    const comments = await harness.ctx.issues.listComments("iss-1", "comp-1");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("@octocat");
    expect(comments[0].body).toContain("#7 Fix widget alignment");
  });

  it("ignores non-created actions", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    harness.seed({
      issues: [makeIssue({ id: "iss-1", companyId: "comp-1", identifier: "CAS-1", title: "Test" })],
    });
    await plugin.definition.setup(harness.ctx);

    const payload = { ...makeCommentEvent("CAS-1"), action: "edited" };
    await plugin.definition.onWebhook!(webhookInput(payload));

    const comments = await harness.ctx.issues.listComments("iss-1", "comp-1");
    expect(comments).toHaveLength(0);
  });

  it("ignores comments without identifiers", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    await plugin.definition.setup(harness.ctx);

    const payload = makeCommentEvent("This is just a normal comment");
    await plugin.definition.onWebhook!(webhookInput(payload));
  });

  it("deduplicates relayed comments", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    harness.seed({
      issues: [makeIssue({ id: "iss-1", companyId: "comp-1", identifier: "CAS-10", title: "Test" })],
    });
    await plugin.definition.setup(harness.ctx);

    const payload = makeCommentEvent("Fixes CAS-10", 100);
    await plugin.definition.onWebhook!(webhookInput(payload));
    await plugin.definition.onWebhook!(webhookInput(payload));

    const comments = await harness.ctx.issues.listComments("iss-1", "comp-1");
    expect(comments).toHaveLength(1);
  });

  it("ignores non-PR comments", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    harness.seed({
      issues: [makeIssue({ id: "iss-1", companyId: "comp-1", identifier: "CAS-5", title: "Test" })],
    });
    await plugin.definition.setup(harness.ctx);

    const payload = makeCommentEvent("CAS-5 fix");
    delete (payload as any).pull_request;
    await plugin.definition.onWebhook!(webhookInput(payload));

    const comments = await harness.ctx.issues.listComments("iss-1", "comp-1");
    expect(comments).toHaveLength(0);
  });

  it("ignores non-comment GitHub events", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"] });
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onWebhook!(webhookInput({}, "push"));
  });
});
