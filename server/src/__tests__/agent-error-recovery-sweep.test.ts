import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent error-recovery sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileErroredAgents (agent error-state auto-recovery sweep)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COOLDOWN_MS = 30 * 60 * 1000;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-error-recovery-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertErroredAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maya",
      role: "marketer",
      status: "error",
      errorReason: "Internal error: You've hit your session limit · resets 12am (Europe/Rome)",
      updatedAt: new Date(Date.now() - COOLDOWN_MS - 60_000),
      ...overrides,
    });
    return agentId;
  }

  async function insertRun(companyId: string, agentId: string, errorCode: string | null) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "failed",
      responsibleUserId: "responsible-user",
      errorCode,
    });
  }

  async function getAgentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("clears a retryable agent past cooldown and records the attempt", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId);
    await insertRun(companyId, agentId, "provider_quota");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const now = new Date();
    const result = await heartbeat.reconcileErroredAgents(now);

    expect(result).toMatchObject({ scanned: 1, cleared: 1, exhausted: 0, skippedNotRetryable: 0 });
    expect(result.clearedAgentIds).toEqual([agentId]);

    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("idle");
    expect(row?.errorReason).toBeNull();
    expect(row?.metadata).toMatchObject({
      errorRecovery: { attempts: 1, lastErrorFamily: "provider_quota" },
    });
  });

  it("does not clear an agent before the cooldown elapses", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId, { updatedAt: new Date(Date.now() - 5 * 60 * 1000) });
    await insertRun(companyId, agentId, "provider_quota");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);

    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
  });

  it("does not clear a non-retryable error family", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId);
    await insertRun(companyId, agentId, "setup_failed");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result).toMatchObject({ scanned: 1, cleared: 0, skippedNotRetryable: 1 });

    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).not.toBeNull();
  });

  it("never touches paused or terminated agents even with stale timestamps", async () => {
    const companyId = await insertCompany();
    const pausedId = randomUUID();
    const terminatedId = randomUUID();
    const staleUpdatedAt = new Date(Date.now() - COOLDOWN_MS - 60_000);

    await db.insert(agents).values([
      {
        id: pausedId,
        companyId,
        name: "Paused Agent",
        role: "engineer",
        status: "paused",
        errorReason: null,
        updatedAt: staleUpdatedAt,
      },
      {
        id: terminatedId,
        companyId,
        name: "Terminated Agent",
        role: "engineer",
        status: "terminated",
        errorReason: null,
        updatedAt: staleUpdatedAt,
      },
    ]);

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);

    const paused = await getAgentRow(pausedId);
    const terminated = await getAgentRow(terminatedId);
    expect(paused?.status).toBe("paused");
    expect(terminated?.status).toBe("terminated");
  });

  it("stops auto-clearing after the configured max attempts and keeps the alert live", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId);
    await insertRun(companyId, agentId, "provider_quota");

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { AGENT_ERROR_RECOVERY_MAX_ATTEMPTS: "2" },
    });

    let t = Date.now();
    // Attempt 1: clears, then the agent immediately fails again.
    let result = await heartbeat.reconcileErroredAgents(new Date(t));
    expect(result.cleared).toBe(1);
    t += COOLDOWN_MS + 1_000;
    await db.update(agents).set({ status: "error", errorReason: "quota again", updatedAt: new Date(t) }).where(eq(agents.id, agentId));

    // Attempt 2 (backoff-gated: cooldown * 2^1 since attempts=1 already used).
    // Advance the clock only - do not re-touch updatedAt, since nothing writes
    // to the row between the failure at t (above) and this sweep in production;
    // re-touching it here would defeat the base "just entered error" debounce
    // that reconcileErroredAgents gates candidacy on.
    t += COOLDOWN_MS * 2 + 1_000;
    result = await heartbeat.reconcileErroredAgents(new Date(t));
    expect(result.cleared).toBe(1);

    let row = await getAgentRow(agentId);
    expect(row?.metadata).toMatchObject({ errorRecovery: { attempts: 2 } });

    t += COOLDOWN_MS + 1_000;
    await db.update(agents).set({ status: "error", errorReason: "quota yet again", updatedAt: new Date(t) }).where(eq(agents.id, agentId));

    // Attempt 3 would exceed maxAttempts (2) - must stop clearing and mark exhausted.
    t += COOLDOWN_MS * 4 + 1_000;
    result = await heartbeat.reconcileErroredAgents(new Date(t));

    expect(result.cleared).toBe(0);
    expect(result.exhausted).toBe(1);
    expect(result.exhaustedAgentIds).toEqual([agentId]);

    row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).not.toBeNull();
    expect(row?.metadata).toMatchObject({
      errorRecovery: { attempts: 2, exhaustedAt: expect.any(String) },
    });

    // A further sweep keeps it exhausted (bounded, not flapping) and the
    // existing agent_error_alert machinery (attention.ts) continues to see a
    // plain status = 'error' row, so the human-facing alert is unaffected.
    t += COOLDOWN_MS * 8;
    result = await heartbeat.reconcileErroredAgents(new Date(t));
    expect(result.cleared).toBe(0);
    expect(result.exhausted).toBe(1);
    row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
  });

  it("is idempotent under concurrent invocation (CAS covers double-clearing)", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId);
    await insertRun(companyId, agentId, "claude_transient_upstream");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const now = new Date();

    const [first, second] = await Promise.all([
      heartbeat.reconcileErroredAgents(now),
      heartbeat.reconcileErroredAgents(now),
    ]);

    const totalCleared = first.cleared + second.cleared;
    expect(totalCleared).toBe(1);

    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("idle");
    expect(row?.metadata).toMatchObject({ errorRecovery: { attempts: 1 } });
  });

  it("flags agents whose error has been open for more than 24h", async () => {
    const companyId = await insertCompany();
    const agentId = await insertErroredAgent(companyId, {
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await insertRun(companyId, agentId, "setup_failed");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileErroredAgents(new Date());

    expect(result.staleErrorAgentIds).toEqual([agentId]);
  });
});
