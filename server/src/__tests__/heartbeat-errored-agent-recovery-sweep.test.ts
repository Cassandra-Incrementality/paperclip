import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyAgentErrorReasonFamily, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres errored-agent recovery sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Pure classifier tests need no database and run unconditionally.
describe("classifyAgentErrorReasonFamily", () => {
  it("classifies the literal PPC-3290 session-limit strings as provider_quota", () => {
    expect(
      classifyAgentErrorReasonFamily(
        "Internal error: You've hit your session limit · resets 12am (Europe/Rome)",
      ),
    ).toBe("provider_quota");
    expect(
      classifyAgentErrorReasonFamily(
        "Claude run failed: subtype=success: You've hit your session limit",
      ),
    ).toBe("provider_quota");
  });

  it("classifies generic upstream-outage phrasing as transient_upstream", () => {
    expect(classifyAgentErrorReasonFamily("upstream returned a 503 error")).toBe("transient_upstream");
    expect(classifyAgentErrorReasonFamily("request timed out after 30s")).toBe("transient_upstream");
    expect(classifyAgentErrorReasonFamily("provider overloaded, please retry")).toBe("transient_upstream");
  });

  it("returns null for unclassifiable or empty reasons", () => {
    expect(classifyAgentErrorReasonFamily("workspace missing required secret FOO_TOKEN")).toBeNull();
    expect(classifyAgentErrorReasonFamily(null)).toBeNull();
    expect(classifyAgentErrorReasonFamily("")).toBeNull();
  });
});

describeEmbeddedPostgres("reconcileErroredAgents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-errored-agent-recovery-sweep-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedErroredAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> & { updatedAt: Date },
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Motion Editor",
      role: "engineer",
      status: overrides.status ?? "error",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      errorReason: overrides.errorReason ?? "upstream returned a 503 error",
      metadata: overrides.metadata ?? null,
      updatedAt: overrides.updatedAt,
    });
    return agentId;
  }

  it("clears a transient-family errored agent to idle once the cooldown has elapsed", async () => {
    const companyId = await seedCompany();
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago, past 30m cooldown
    const agentId = await seedErroredAgent(companyId, { updatedAt: staleUpdatedAt });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.cleared).toBe(1);
    expect(result.clearedAgentIds).toContain(agentId);

    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(row?.status).toBe("idle");
    expect(row?.errorReason).toBeNull();
    const recovery = (row?.metadata as Record<string, unknown> | null)?.errorRecovery as
      | Record<string, unknown>
      | undefined;
    expect(recovery?.attempts).toBe(1);
    expect(recovery?.family).toBe("transient_upstream");
  });

  it("does not touch an errored agent still inside the cooldown window", async () => {
    const companyId = await seedCompany();
    const recentUpdatedAt = new Date(Date.now() - 5 * 60 * 1000); // 5m ago, inside 30m cooldown
    const agentId = await seedErroredAgent(companyId, { updatedAt: recentUpdatedAt });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.cleared).toBe(0);
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(row?.status).toBe("error");
  });

  it("stops auto-clearing after the max attempt bound and leaves the agent in error", async () => {
    const companyId = await seedCompany();
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const agentId = await seedErroredAgent(companyId, {
      updatedAt: staleUpdatedAt,
      metadata: { errorRecovery: { attempts: 3, family: "transient_upstream" } },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileErroredAgents(new Date(), { maxAttempts: 3 });

    expect(result.cleared).toBe(0);
    expect(result.skippedExhausted).toBe(1);
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).not.toBeNull();
  });

  it("never touches paused or terminated agents even if stale and matching a retryable family", async () => {
    const companyId = await seedCompany();
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const pausedId = await seedErroredAgent(companyId, {
      updatedAt: staleUpdatedAt,
      status: "paused",
      name: "Paused Agent",
    });
    const terminatedId = await seedErroredAgent(companyId, {
      updatedAt: staleUpdatedAt,
      status: "terminated",
      name: "Terminated Agent",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.cleared).toBe(0);
    const paused = await db.select().from(agents).where(eq(agents.id, pausedId)).then((rows) => rows[0]);
    const terminated = await db
      .select()
      .from(agents)
      .where(eq(agents.id, terminatedId))
      .then((rows) => rows[0]);
    expect(paused?.status).toBe("paused");
    expect(terminated?.status).toBe("terminated");
  });

  it("is idempotent under concurrent invocation via the CAS WHERE clause", async () => {
    const companyId = await seedCompany();
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const agentId = await seedErroredAgent(companyId, { updatedAt: staleUpdatedAt });

    const heartbeat = heartbeatService(db);
    const now = new Date();
    const [first, second] = await Promise.all([
      heartbeat.reconcileErroredAgents(now),
      heartbeat.reconcileErroredAgents(now),
    ]);

    // Exactly one invocation observes the row still in 'error' and clears it;
    // the CAS WHERE clause guarantees the other clears zero rows.
    expect(first.cleared + second.cleared).toBe(1);

    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(row?.status).toBe("idle");
  });
});
