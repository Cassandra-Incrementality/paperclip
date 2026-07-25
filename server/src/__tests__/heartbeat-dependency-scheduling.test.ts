import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId: randomUUID() },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, interactionWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  it("defers issue_blockers_resolved as a follow-up when the same issue is already running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "manual_test_active_run",
      },
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Completed prerequisite",
        status: "done",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    runningProcesses.set(activeRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerId}`;
    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });

    expect(wake).toBeNull();

    const wakeRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    expect(wakeRequests).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        idempotencyKey,
        runId: null,
      }),
    ]);

    runningProcesses.delete(activeRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activeRunId));
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("caps a burst of simultaneous assignment wakes at maxConcurrentRuns instead of running them all at once (PPC-2416..2422 regression)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const CAP = 3;
    const BURST_SIZE = 7;
    const issueIds = Array.from({ length: BURST_SIZE }, () => randomUUID());

    let concurrent = 0;
    let peakConcurrent = 0;
    let myCallCount = 0;
    const pendingResolvers: Array<() => void> = [];
    const issueIdSet = new Set(issueIds);

    mockAdapterExecute.mockImplementation(async (params: { context?: Record<string, unknown> }) => {
      const issueId = typeof params?.context?.issueId === "string" ? params.context.issueId : null;
      const isMine = issueId !== null && issueIdSet.has(issueId);
      if (!isMine) {
        // A previous test in this shared-mock file can still have background
        // continuation work in flight when this test starts (visible as "failed to
        // refresh issue continuation summary" warnings for other agent ids). Resolve
        // those immediately so they can't pollute this test's concurrency counters.
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Unrelated stray run from another test.",
          provider: "test",
          model: "test-model",
        };
      }
      myCallCount += 1;
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        pendingResolvers.push(() => {
          concurrent -= 1;
          resolve();
        });
      });
      // Mark the issue done so the platform's own continuation logic (re-queueing a
      // follow-up run for issues left in_progress) doesn't add extra runs on top of
      // the 7 under test — that behavior is real but orthogonal to this regression.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId!));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Burst assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BurstCTO",
      role: "cto",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: CAP,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values(
      issueIds.map((issueId, index) => ({
        id: issueId,
        companyId,
        title: `Quick win ${index + 1}`,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      })),
    );

    // Reproduce the 2026-07-10 incident: 7 issues assigned to the same agent within
    // a ~4-second window (PPC-2416..2422, routed from card PPC-2348). All 7 wakeups
    // land essentially at once, the way concurrent comment-mutation webhooks did in prod.
    const wakes = await Promise.all(
      issueIds.map((issueId) =>
        heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId },
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        }),
      ),
    );
    expect(wakes.every((wake) => wake !== null)).toBe(true);

    const capReached = await waitForCondition(async () => myCallCount === CAP, 10_000);
    expect(capReached).toBe(true);

    // Give the dispatcher a beat to misbehave (start more than CAP) before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(myCallCount).toBe(CAP);

    const statusCounts = async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .then((rows) => {
          const counts: Record<string, number> = {};
          for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
          return counts;
        });

    expect((await statusCounts()).running).toBe(CAP);
    expect((await statusCounts()).queued).toBe(BURST_SIZE - CAP);

    // Drain everything currently in-flight, in rounds, until nothing new gets queued
    // (bounded — this also tolerates the platform queueing incidental follow-up runs,
    // which is real behavior but not what this regression test is checking).
    for (let round = 0; round < 30; round += 1) {
      const batch = pendingResolvers.splice(0, pendingResolvers.length);
      if (batch.length > 0) {
        batch.forEach((resolve) => resolve());
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const stillActive = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .then((rows) => rows.some((row) => row.status === "queued" || row.status === "running"));
      if (!stillActive) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const finalRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    for (const issueId of issueIds) {
      const succeededForIssue = finalRuns.some(
        (run) => (run.contextSnapshot as { issueId?: string } | null)?.issueId === issueId && run.status === "succeeded",
      );
      expect(succeededForIssue).toBe(true);
    }

    // The core regression check: no issue was dropped, but the agent never ran more
    // than CAP claude_local child processes at once — unlike the July 10 incident,
    // where all 7 ran concurrently (default cap was 20).
    expect(myCallCount).toBeGreaterThanOrEqual(BURST_SIZE);
    expect(peakConcurrent).toBeLessThanOrEqual(CAP);
    expect(peakConcurrent).toBe(CAP);
  }, 40_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });
});
