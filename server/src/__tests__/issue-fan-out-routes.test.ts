import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({
    totalComments: 0,
    latestCommentId: null,
    latestCommentAt: null,
  })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  fanOut: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  knowledgeService: () => ({
    crystallize: vi.fn(async () => ({ documentsCreated: 0, documentsReinforced: 0, issueIdentifier: null })),
    getContextForTask: vi.fn(async () => []),
    search: vi.fn(async () => []),
    reinforce: vi.fn(async () => null),
    upsertWikiDocument: vi.fn(async () => null),
    listWikiDocuments: vi.fn(async () => []),
    getWikiDocument: vi.fn(async () => null),
    getStats: vi.fn(async () => ({ total: 0, byKind: {}, byTier: {}, details: [] })),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "parent-1",
    companyId: "company-1",
    identifier: "TST-1",
    title: "Parent issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-owner",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function makeChild(id: string, assigneeAgentId: string | null = "agent-child") {
  return {
    id,
    companyId: "company-1",
    identifier: `TST-${id}`,
    title: `Child ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    parentId: "parent-1",
    assigneeAgentId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

async function createApp(actorOverride?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/issues/:id/fan-out", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(false);
  });

  it("happy path: creates 3 children, transitions parent to blocked, fires wakeup per assigned child", async () => {
    const parent = makeIssue();
    const children = [
      makeChild("child-1", "agent-a"),
      makeChild("child-2", "agent-b"),
      makeChild("child-3", null),
    ];
    const updatedParent = makeIssue({ status: "blocked" });

    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.fanOut.mockResolvedValue({ parent: updatedParent, children });

    const res = await request(await createApp())
      .post("/api/issues/parent-1/fan-out")
      .send({
        children: [
          { title: "Child 1", assigneeAgentId: "00000000-0000-0000-0000-000000000001" },
          { title: "Child 2", assigneeAgentId: "00000000-0000-0000-0000-000000000002" },
          { title: "Child 3" },
        ],
        parent: { status: "blocked", comment: "Fanning out." },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      parent: { id: "parent-1", status: "blocked" },
      children: expect.arrayContaining([
        expect.objectContaining({ id: "child-1" }),
        expect.objectContaining({ id: "child-2" }),
        expect.objectContaining({ id: "child-3" }),
      ]),
      runId: null,
    });

    // Wakeup fires for the 2 assigned children, not the unassigned one
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(2);
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-a",
        expect.objectContaining({ reason: "issue_assigned" }),
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-b",
        expect.objectContaining({ reason: "issue_assigned" }),
      );
    });
  });

  it("cancellation path: parent wakes via issue_children_completed when a child is cancelled", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        id: "child-c",
        identifier: "TST-99",
        title: "Child C",
        status: "in_progress",
        parentId: "parent-1",
        assigneeAgentId: "agent-child",
      }),
    );
    mockIssueService.update.mockResolvedValue(
      makeIssue({
        id: "child-c",
        identifier: "TST-99",
        title: "Child C",
        status: "cancelled",
        parentId: "parent-1",
        assigneeAgentId: "agent-child",
      }),
    );
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-owner",
      childIssueIds: ["child-a", "child-b", "child-c"],
    });

    const res = await request(await createApp())
      .patch("/api/issues/child-c")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-owner",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-c",
          }),
        }),
      );
    });
  });

  it("partial-create rollback: service error surfaces as 422, caller sees no partial success", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockIssueService.fanOut.mockRejectedValue(
      new HttpError(422, "Agent not found: 00000000-0000-0000-0000-000000000099"),
    );

    const res = await request(await createApp())
      .post("/api/issues/parent-1/fan-out")
      .send({
        children: [
          { title: "Child A", assigneeAgentId: "00000000-0000-0000-0000-000000000001" },
          { title: "Child B", assigneeAgentId: "00000000-0000-0000-0000-000000000099" },
          { title: "Child C" },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Agent not found") });
    // No wakeups — no children were created
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("workspace inheritance: children in response carry the parent workspace id", async () => {
    const parent = makeIssue({ executionWorkspaceId: "ws-parent" });
    const children = [
      makeChild("child-ws-1", "agent-ws"),
      makeChild("child-ws-2", null),
    ].map((c) => ({ ...c, executionWorkspaceId: "ws-parent" }));
    const updatedParent = makeIssue({ status: "blocked", executionWorkspaceId: "ws-parent" });

    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.fanOut.mockResolvedValue({ parent: updatedParent, children });

    const res = await request(await createApp())
      .post("/api/issues/parent-1/fan-out")
      .send({
        children: [
          { title: "Child WS 1", assigneeAgentId: "00000000-0000-0000-0000-000000000001" },
          { title: "Child WS 2" },
        ],
      });

    expect(res.status).toBe(200);
    for (const child of res.body.children) {
      expect(child.executionWorkspaceId).toBe("ws-parent");
    }
  });

  it("permission: non-assignee agent without tasks:assign permission receives 403", async () => {
    const parent = makeIssue({ assigneeAgentId: "agent-owner" });
    mockIssueService.getById.mockResolvedValue(parent);
    mockAccessService.hasPermission.mockResolvedValue(false);

    const agentActor = {
      type: "agent",
      agentId: "agent-interloper",
      companyIds: ["company-1"],
      source: "jwt",
      isInstanceAdmin: false,
    };

    const res = await request(await createApp(agentActor))
      .post("/api/issues/parent-1/fan-out")
      .send({
        children: [{ title: "Sneaky child" }],
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.fanOut).not.toHaveBeenCalled();
  });
});
