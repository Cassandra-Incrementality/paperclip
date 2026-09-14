import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
    `Skipping embedded Postgres stale error-latch sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OAUTH_ERROR_REASON = "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed";

describeEmbeddedPostgres("reconcileStaleErrorLatches (PPC-4088 stale error-latch reconciler)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("stale-error-latch-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
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

  async function insertAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Agent",
      role: "engineer",
      status: "idle",
      errorReason: null,
      lastHeartbeatAt: null,
      updatedAt: new Date(),
      ...overrides,
    });
    return agentId;
  }

  async function getAgentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("auto-clears an OAuth-latched agent proven stale by a sibling's later heartbeat", async () => {
    const companyId = await insertCompany();
    const erroredAt = new Date("2026-08-26T22:51:00.000Z");
    const victimId = await insertAgent(companyId, {
      name: "Data Scientist 3",
      status: "error",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: erroredAt,
    });
    await insertAgent(companyId, {
      name: "DevOps",
      status: "idle",
      lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorLatches(new Date("2026-08-28T03:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, cleared: 1 });
    expect(result.clearedAgentIds).toEqual([victimId]);

    const row = await getAgentRow(victimId);
    expect(row?.status).toBe("idle");
    // errorReason is server-owned free text; the reconciler still clears it
    // exactly like the sanctioned clear-error endpoint does.
    expect(row?.errorReason).toBeNull();
  });

  it("does not clear a genuine unrelated error even when a sibling heartbeats later (PPC-4085 guard)", async () => {
    const companyId = await insertCompany();
    const vpProductId = await insertAgent(companyId, {
      name: "VP Product",
      status: "error",
      errorReason: "adapter execution timeout (timeoutSec=1000)",
      updatedAt: new Date("2026-08-27T18:00:00.000Z"),
    });
    await insertAgent(companyId, {
      name: "DevOps",
      status: "idle",
      lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorLatches(new Date("2026-08-28T03:00:00.000Z"));

    expect(result.cleared).toBe(0);

    const row = await getAgentRow(vpProductId);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).not.toBeNull();
  });

  it("does not clear across companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const victimId = await insertAgent(companyA, {
      name: "Data Scientist 3",
      status: "error",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-26T22:51:00.000Z"),
    });
    await insertAgent(companyB, {
      name: "Unrelated Tenant Agent",
      status: "idle",
      lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorLatches(new Date("2026-08-28T03:00:00.000Z"));

    expect(result.cleared).toBe(0);
    const row = await getAgentRow(victimId);
    expect(row?.status).toBe("error");
  });

  it("is idempotent under concurrent invocation (CAS covers double-clearing)", async () => {
    const companyId = await insertCompany();
    const victimId = await insertAgent(companyId, {
      name: "Data Scientist 3",
      status: "error",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-26T22:51:00.000Z"),
    });
    await insertAgent(companyId, {
      name: "DevOps",
      status: "idle",
      lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const now = new Date("2026-08-28T03:00:00.000Z");

    const [first, second] = await Promise.all([
      heartbeat.reconcileStaleErrorLatches(now),
      heartbeat.reconcileStaleErrorLatches(now),
    ]);

    expect(first.cleared + second.cleared).toBe(1);

    const row = await getAgentRow(victimId);
    expect(row?.status).toBe("idle");
  });

  it("never clobbers a manually-cleared/paused agent (lost CAS race is a no-op)", async () => {
    const companyId = await insertCompany();
    const victimId = await insertAgent(companyId, {
      name: "Data Scientist 3",
      status: "error",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-26T22:51:00.000Z"),
    });
    await insertAgent(companyId, {
      name: "DevOps",
      status: "idle",
      lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
    });

    // Simulate a human manually pausing the agent between the read and the sweep.
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, victimId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorLatches(new Date("2026-08-28T03:00:00.000Z"));

    // The candidate select happens inside the sweep itself, so a status that
    // already moved off 'error' before the sweep runs is simply not scanned.
    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);

    const row = await getAgentRow(victimId);
    expect(row?.status).toBe("paused");
  });
});

describeEmbeddedPostgres("reconcileStaleErrorReasonResidue (PPC-5088 residue sweep)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("stale-error-reason-residue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
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

  async function insertAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Agent",
      role: "engineer",
      status: "idle",
      errorReason: null,
      lastHeartbeatAt: null,
      updatedAt: new Date(),
      ...overrides,
    });
    return agentId;
  }

  async function getAgentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("clears leftover errorReason left behind by a status-only PATCH (PPC-5088: Video Producer)", async () => {
    const companyId = await insertCompany();
    // Reproduces the exact row shape found live on PPC-5088: status flipped
    // to idle by a status-only PATCH (activity_log changedTopLevelKeys:
    // ["status"]) without errorReason or updatedAt moving alongside it.
    const videoProducerId = await insertAgent(companyId, {
      name: "Video Producer",
      status: "idle",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-28T02:04:37.244Z"),
      lastHeartbeatAt: new Date("2026-08-26T14:07:19.117Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorReasonResidue(new Date("2026-09-14T12:09:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, cleared: 1 });
    expect(result.clearedAgentIds).toEqual([videoProducerId]);

    const row = await getAgentRow(videoProducerId);
    expect(row?.status).toBe("idle"); // untouched - there was no latch, only text
    expect(row?.errorReason).toBeNull();
  });

  it("does not touch an agent that is still genuinely latched in status='error'", async () => {
    const companyId = await insertCompany();
    const victimId = await insertAgent(companyId, {
      name: "Data Scientist 3",
      status: "error",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-26T22:51:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorReasonResidue(new Date("2026-08-28T03:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 0, cleared: 0 });
    const row = await getAgentRow(victimId);
    expect(row?.errorReason).toBe(OAUTH_ERROR_REASON);
  });

  it("does not scan an agent that has already moved to status='error' before the sweep's select", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId, {
      name: "Video Producer",
      status: "idle",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-28T02:04:37.244Z"),
    });

    // A brand-new, unrelated error lands before the sweep ever runs.
    await db
      .update(agents)
      .set({ status: "error", errorReason: "adapter execution timeout (timeoutSec=1000)" })
      .where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileStaleErrorReasonResidue(new Date("2026-09-14T12:09:00.000Z"));

    expect(result).toMatchObject({ scanned: 0, cleared: 0 });
    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).toBe("adapter execution timeout (timeoutSec=1000)");
  });

  it("is idempotent under concurrent invocation (CAS covers double-clearing)", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId, {
      name: "Video Producer",
      status: "idle",
      errorReason: OAUTH_ERROR_REASON,
      updatedAt: new Date("2026-08-28T02:04:37.244Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const now = new Date("2026-09-14T12:09:00.000Z");

    const [first, second] = await Promise.all([
      heartbeat.reconcileStaleErrorReasonResidue(now),
      heartbeat.reconcileStaleErrorReasonResidue(now),
    ]);

    expect(first.cleared + second.cleared).toBe(1);
    const row = await getAgentRow(agentId);
    expect(row?.errorReason).toBeNull();
  });
});
