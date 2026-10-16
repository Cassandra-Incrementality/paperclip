import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

// See issue-dependency-wakeups-routes.test.ts for why this cold-start headroom
// is needed: the first test in a suite that imports the large routes/issues.ts
// module through `vi.importActual` pays a one-time transform/execution cost.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(async () => ({
    issueId: "issue-1",
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
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

async function createApp() {
  // vi.resetModules() in beforeEach means the `@paperclipai/db` instance that
  // routes/issues.ts resolves against (imported below via vi.importActual)
  // is a fresh module instance, distinct from any top-level import in this
  // file — resolve `agents` the same way so table-identity comparisons below
  // actually match.
  const { agents } = await vi.importActual<typeof import("@paperclipai/db")>("@paperclipai/db");
  // Every raw db.select() in this route resolves to an empty result, except a
  // lookup against the `agents` table (the unblockDescriptor agent-owner
  // existence check), which resolves to a single matching row so a repair
  // naming `{ agentId: targetAgentId }` as owner validates.
  function rowsFor(table: unknown) {
    return table === agents ? [{ id: targetAgentId }] : [];
  }
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows = rowsFor(table);
        const whereResult = {
          limit: vi.fn(async () => rows),
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
        };
        const query: Record<string, unknown> = {};
        query.innerJoin = vi.fn(() => query);
        query.where = vi.fn(() => whereResult);
        return query;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const issueId = "11111111-1111-4111-8111-111111111111";
const targetAgentId = "00000000-0000-4000-8000-000000000009";
const blockedTransitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);

function blockedIssueRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    identifier: "PAP-6357",
    title: "Blocked issue",
    description: null,
    status: "blocked",
    priority: "high",
    parentId: null,
    assigneeAgentId: "agent-owner",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    blockedTransitionAt,
    blockedOwnerNotifiedAt: null,
    unblockDescriptor: { owner: "board", action: "Board operator: inspect the run evidence" },
    ...overrides,
  };
}

describe("unblock descriptor repair on an already-blocked issue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("wakes the newly-named owner when a boilerplate descriptor is replaced while the issue stays blocked", async () => {
    mockIssueService.getById.mockResolvedValue(blockedIssueRecord());
    mockIssueService.update.mockResolvedValue(blockedIssueRecord({
      unblockDescriptor: { owner: { agentId: targetAgentId }, action: "Deploy the PPC-6171 v2 branch" },
      // The service layer must reset this to null when the descriptor actually
      // changes while already blocked, otherwise the delivery guard treats the
      // owner as already notified and skips the wakeup.
      blockedOwnerNotifiedAt: null,
    }));

    const res = await request(await createApp()).patch(`/api/issues/${issueId}`).send({
      unblockDescriptor: { owner: { agentId: targetAgentId }, action: "Deploy the PPC-6171 v2 branch" },
    });

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledWith(
      targetAgentId,
      expect.objectContaining({
        reason: "issue_unblock_requested",
        idempotencyKey: `issue-unblock:${issueId}:${blockedTransitionAt.toISOString()}`,
        payload: { issueId, action: "Deploy the PPC-6171 v2 branch" },
      }),
    );
  });

  it("does not re-wake the owner when the PATCH resends the same descriptor", async () => {
    const descriptor = { owner: { agentId: targetAgentId }, action: "Deploy the PPC-6171 v2 branch" };
    const alreadyNotifiedAt = new Date("2026-10-14T18:12:00.000Z");
    mockIssueService.getById.mockResolvedValue(blockedIssueRecord({
      unblockDescriptor: descriptor,
      blockedOwnerNotifiedAt: alreadyNotifiedAt,
    }));
    mockIssueService.update.mockResolvedValue(blockedIssueRecord({
      unblockDescriptor: descriptor,
      blockedOwnerNotifiedAt: alreadyNotifiedAt,
    }));

    const res = await request(await createApp()).patch(`/api/issues/${issueId}`).send({
      unblockDescriptor: descriptor,
    });

    expect(res.status).toBe(200);
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not wake anyone when the repaired descriptor still names the board", async () => {
    mockIssueService.getById.mockResolvedValue(blockedIssueRecord());
    mockIssueService.update.mockResolvedValue(blockedIssueRecord({
      unblockDescriptor: { owner: "board", action: "Board operator: a different action" },
      blockedOwnerNotifiedAt: null,
    }));

    const res = await request(await createApp()).patch(`/api/issues/${issueId}`).send({
      unblockDescriptor: { owner: "board", action: "Board operator: a different action" },
    });

    expect(res.status).toBe(200);
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
