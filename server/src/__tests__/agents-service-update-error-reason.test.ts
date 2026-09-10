import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service update (PPC-4933 stale errorReason on manual status change)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-update-error-reason-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertErroredAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MMM Modeler 2",
      role: "engineer",
      status: "error",
      errorReason: "ACP agent disconnected during request (connection_close, exit=null, signal=null)",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return agentId;
  }

  it("clears errorReason when a manual PATCH moves status away from error", async () => {
    const agentId = await insertErroredAgent();

    const updated = await agentService(db).update(agentId, { status: "idle" });

    expect(updated).toMatchObject({ id: agentId, status: "idle", errorReason: null });
  });

  it("does not touch errorReason when the caller explicitly sets it in the same patch", async () => {
    const agentId = await insertErroredAgent();

    const updated = await agentService(db).update(agentId, {
      status: "idle",
      errorReason: "operator note: keep for audit",
    });

    expect(updated).toMatchObject({
      id: agentId,
      status: "idle",
      errorReason: "operator note: keep for audit",
    });
  });

  it("leaves errorReason untouched when the patch does not change status", async () => {
    const agentId = await insertErroredAgent();

    const updated = await agentService(db).update(agentId, { name: "MMM Modeler 2 (renamed)" });

    expect(updated).toMatchObject({
      id: agentId,
      status: "error",
      errorReason: "ACP agent disconnected during request (connection_close, exit=null, signal=null)",
    });
  });
});
