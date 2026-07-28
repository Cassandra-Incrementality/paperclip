import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

// PPC-3187: the per-issue execution lock (`issues.executionRunId`) guards the
// issue a run *executes on*, not the issues a run *writes to*. Two sibling
// runs of one agent can both write authoritative rulings into a third issue's
// thread — that is exactly how PPC-3160 got two contradicting rulings 61
// seconds apart from one agent (diagnosed on PPC-3186). This suite proves the
// service-layer guard added to `issueService(db).addComment` closes that gap.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres same-agent concurrent thread guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const STALE_CHECKOUT_LOCK_TTL_MS = 10 * 60 * 1000;

describeEmbeddedPostgres("PPC-3187: same-agent concurrent thread write guard", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-same-agent-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guard Co",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Chief Scientist") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(companyId: string, title = "Thread under contention") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "in_progress",
      priority: "high",
    });
    return issueId;
  }

  async function seedRun(companyId: string, agentId: string, opts?: { status?: string; updatedAt?: Date }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: opts?.status ?? "running",
      updatedAt: opts?.updatedAt ?? new Date(),
    });
    return runId;
  }

  it("replays the PPC-3160 mechanism: whichever sibling run of one agent writes first wins, the other is rejected with the winner's body", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // Ordering 1: R1 writes first, R2 (sibling run, same agent) is rejected.
    const issueA = await seedIssue(companyId, "SRF ordering — R1 first");
    const r1 = await seedRun(companyId, agentId);
    const r2 = await seedRun(companyId, agentId);

    const c1 = await svc.addComment(issueA, "Ruling: three-entry spec.", { agentId, runId: r1 });
    expect(c1.body).toBe("Ruling: three-entry spec.");

    await expect(
      svc.addComment(issueA, "Ruling: Option 4.", { agentId, runId: r2 }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Concurrent same-agent write to this thread",
      details: {
        issueId: issueA,
        conflictingRunId: r1,
        conflictingCommentId: c1.id,
        conflictingCommentBody: "Ruling: three-entry spec.",
        guidance: expect.stringContaining("reconcile"),
      },
    });

    // Ordering 2 (mirrored, fresh thread): R2 writes first, R1 is rejected —
    // proves the guard protects whichever run gets there first, not a fixed
    // run, matching the "second writer reconciles" rationale from PPC-3186
    // (the rejected write on PPC-3160 was actually the correct ruling).
    const issueB = await seedIssue(companyId, "SRF ordering — R2 first");
    const r1b = await seedRun(companyId, agentId);
    const r2b = await seedRun(companyId, agentId);

    const c2 = await svc.addComment(issueB, "Ruling: Option 4 (direct).", { agentId, runId: r2b });

    await expect(
      svc.addComment(issueB, "Ruling: three-entry spec (stale).", { agentId, runId: r1b }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        issueId: issueB,
        conflictingRunId: r2b,
        conflictingCommentId: c2.id,
        conflictingCommentBody: "Ruling: Option 4 (direct).",
      },
    });
  });

  it("allows a run to post a second comment on the same thread (normal reasoning-then-result posting)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const r1 = await seedRun(companyId, agentId);

    await svc.addComment(issueId, "Reasoning...", { agentId, runId: r1 });
    const second = await svc.addComment(issueId, "Result.", { agentId, runId: r1 });
    expect(second.body).toBe("Result.");
  });

  it("does not fire across different agents — cross-agent discussion stays free", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "Agent A");
    const agentB = await seedAgent(companyId, "Agent B");
    const issueId = await seedIssue(companyId);
    const runA = await seedRun(companyId, agentA);
    const runB = await seedRun(companyId, agentB);

    await svc.addComment(issueId, "Agent A's take.", { agentId: agentA, runId: runA });
    const reply = await svc.addComment(issueId, "Agent B's take.", { agentId: agentB, runId: runB });
    expect(reply.body).toBe("Agent B's take.");
  });

  it.each(["succeeded", "failed", "interrupted", "cancelled", "timed_out"] as const)(
    "does not fire when the sibling run has reached the terminal status %s",
    async (status) => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId);
      const r1 = await seedRun(companyId, agentId, { status });
      const r2 = await seedRun(companyId, agentId);

      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: r1,
        body: "Terminal sibling's earlier comment.",
      });

      const comment = await svc.addComment(issueId, "New comment.", { agentId, runId: r2 });
      expect(comment.body).toBe("New comment.");
    },
  );

  it("does not fire once a live sibling run transitions to terminal mid-thread", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const r1 = await seedRun(companyId, agentId, { status: "running" });
    const r2 = await seedRun(companyId, agentId);

    await svc.addComment(issueId, "First ruling.", { agentId, runId: r1 });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, r1));

    const second = await svc.addComment(issueId, "Second ruling after R1 finished.", { agentId, runId: r2 });
    expect(second.body).toBe("Second ruling after R1 finished.");
  });

  it("does not fire when the sibling run is still 'running' but stale (updatedAt older than the 10-minute TTL)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const staleUpdatedAt = new Date(Date.now() - STALE_CHECKOUT_LOCK_TTL_MS - 60_000);
    const r1 = await seedRun(companyId, agentId, { status: "running", updatedAt: staleUpdatedAt });
    const r2 = await seedRun(companyId, agentId);

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: r1,
      body: "Stale sibling's earlier comment.",
      createdAt: staleUpdatedAt,
    });

    const comment = await svc.addComment(issueId, "New comment.", { agentId, runId: r2 });
    expect(comment.body).toBe("New comment.");
  });

  it("fires when the sibling run is 'running' and just inside the 10-minute TTL", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const freshUpdatedAt = new Date(Date.now() - STALE_CHECKOUT_LOCK_TTL_MS + 60_000);
    const r1 = await seedRun(companyId, agentId, { status: "running", updatedAt: freshUpdatedAt });
    const r2 = await seedRun(companyId, agentId);

    const c1 = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: r1,
        body: "Still-live sibling's earlier comment.",
      })
      .returning();

    await expect(
      svc.addComment(issueId, "New comment.", { agentId, runId: r2 }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        conflictingCommentId: c1[0]?.id,
      },
    });
  });

  it("ignores deleted (tombstoned) sibling comments — nothing left to reconcile against", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const r1 = await seedRun(companyId, agentId);
    const r2 = await seedRun(companyId, agentId);

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: r1,
      body: "Retracted ruling.",
      deletedAt: new Date(),
      deletedByType: "agent",
      deletedByAgentId: agentId,
    });

    const comment = await svc.addComment(issueId, "New comment.", { agentId, runId: r2 });
    expect(comment.body).toBe("New comment.");
  });

  it("does not fire from human/board authors (no agentId on the actor)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const r1 = await seedRun(companyId, agentId);

    await svc.addComment(issueId, "Agent ruling.", { agentId, runId: r1 });
    const boardComment = await svc.addComment(issueId, "Board follow-up.", { userId: "local-board" });
    expect(boardComment.body).toBe("Board follow-up.");
  });

  it("can be disabled via the guardSameAgentConcurrentThreadWrites instance setting", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const r1 = await seedRun(companyId, agentId);
    const r2 = await seedRun(companyId, agentId);
    const settings = instanceSettingsService(db);

    await settings.updateGeneral({ guardSameAgentConcurrentThreadWrites: false });
    try {
      await svc.addComment(issueId, "First.", { agentId, runId: r1 });
      const second = await svc.addComment(issueId, "Second, would normally conflict.", { agentId, runId: r2 });
      expect(second.body).toBe("Second, would normally conflict.");
    } finally {
      await settings.updateGeneral({ guardSameAgentConcurrentThreadWrites: true });
    }
  });
});
