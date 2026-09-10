import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  heartbeatRuns,
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
    `Skipping embedded Postgres cancelled-run error-latch sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CONNECTION_CLOSE_ERROR_REASON =
  "ACP agent disconnected during request (connection_close, exit=null, signal=null)";

describeEmbeddedPostgres("reconcileCancelledRunErrorLatches (PPC-4933 cancel-vs-adapter-error race)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("cancelled-run-error-latch-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
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

  async function insertRun(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "cancelled",
      createdAt: new Date("2026-09-10T09:53:22.754Z"),
      ...overrides,
    });
    return runId;
  }

  async function getAgentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("auto-clears an error latch whose agent's most recent run was cancelled", async () => {
    const companyId = await insertCompany();
    const victimId = await insertAgent(companyId, {
      name: "MMM Modeler 2",
      status: "error",
      errorReason: CONNECTION_CLOSE_ERROR_REASON,
      updatedAt: new Date("2026-09-10T09:58:59.148Z"),
    });
    await insertRun(companyId, victimId, {
      status: "cancelled",
      error: "Cancelled by control plane",
      errorCode: "cancelled",
      createdAt: new Date("2026-09-10T09:53:22.754Z"),
      finishedAt: new Date("2026-09-10T09:58:59.110Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileCancelledRunErrorLatches(new Date("2026-09-10T10:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, cleared: 1 });
    expect(result.clearedAgentIds).toEqual([victimId]);

    const row = await getAgentRow(victimId);
    expect(row?.status).toBe("idle");
    expect(row?.errorReason).toBeNull();
  });

  it("does not clear a genuine error whose most recent run failed (not cancelled)", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId, {
      name: "SaaS Engineer",
      status: "error",
      errorReason: "adapter execution timeout (timeoutSec=1000)",
      updatedAt: new Date("2026-09-10T09:58:59.148Z"),
    });
    await insertRun(companyId, agentId, {
      status: "failed",
      error: "adapter execution timeout (timeoutSec=1000)",
      errorCode: "adapter_failed",
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileCancelledRunErrorLatches(new Date("2026-09-10T10:00:00.000Z"));

    expect(result.cleared).toBe(0);
    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.errorReason).not.toBeNull();
  });

  it("does not clear when a genuine failure happened after the last cancelled run", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId, {
      name: "MMM Modeler 2",
      status: "error",
      errorReason: "adapter execution timeout (timeoutSec=1000)",
      updatedAt: new Date("2026-09-10T11:00:00.000Z"),
    });
    await insertRun(companyId, agentId, {
      status: "cancelled",
      error: "Cancelled by control plane",
      errorCode: "cancelled",
      createdAt: new Date("2026-09-10T09:53:22.754Z"),
      finishedAt: new Date("2026-09-10T09:58:59.110Z"),
    });
    await insertRun(companyId, agentId, {
      status: "failed",
      error: "adapter execution timeout (timeoutSec=1000)",
      errorCode: "adapter_failed",
      createdAt: new Date("2026-09-10T10:30:00.000Z"),
      finishedAt: new Date("2026-09-10T11:00:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileCancelledRunErrorLatches(new Date("2026-09-10T11:05:00.000Z"));

    expect(result.cleared).toBe(0);
    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
  });

  it("never clobbers a manually-cleared/paused agent (lost CAS race is a no-op)", async () => {
    const companyId = await insertCompany();
    const victimId = await insertAgent(companyId, {
      name: "MMM Modeler 2",
      status: "error",
      errorReason: CONNECTION_CLOSE_ERROR_REASON,
      updatedAt: new Date("2026-09-10T09:58:59.148Z"),
    });
    await insertRun(companyId, victimId, {
      status: "cancelled",
      error: "Cancelled by control plane",
      errorCode: "cancelled",
    });

    // Simulate a human manually clearing the agent between the read and the sweep.
    await db.update(agents).set({ status: "idle", errorReason: null }).where(eq(agents.id, victimId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.reconcileCancelledRunErrorLatches(new Date("2026-09-10T10:00:00.000Z"));

    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);
  });
});
