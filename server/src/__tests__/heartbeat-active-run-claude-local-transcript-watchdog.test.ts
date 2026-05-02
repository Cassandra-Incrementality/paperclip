import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
} from "../services/recovery/service.ts";
import { recoveryService } from "../services/recovery/service.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres claude_local transcript watchdog tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("claude_local transcript-based liveness (PPC-914)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let projectsRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-local-transcript-watchdog-");
    db = createDb(tempDb.connectionString);
    projectsRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "claude-projects-"));
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await fsPromises.rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  async function seedRun(opts: {
    now: Date;
    ageMs: number;
    adapterType: "claude_local" | "codex_local";
    sessionId: string | null;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);

    await db.insert(companies).values({
      id: companyId,
      name: "TranscriptWatchdog Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: opts.adapterType,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Tool-driven implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      sessionIdAfter: opts.sessionId,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, managerId, coderId, issueId, runId, issuePrefix };
  }

  async function writeTranscriptFile(opts: {
    sessionId: string;
    mtimeMs: number;
    entries: Array<Record<string, unknown>>;
  }) {
    const projectDir = path.join(projectsRoot, "fake-project-dir");
    await fsPromises.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);
    const body = opts.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fsPromises.writeFile(filePath, body);
    const t = opts.mtimeMs / 1000;
    await fsPromises.utimes(filePath, t, t);
    return filePath;
  }

  it("skips claude_local runs whose JSONL transcript was written within the suspicion window", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const sessionId = randomUUID();
    await seedRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      adapterType: "claude_local",
      sessionId,
    });
    await writeTranscriptFile({
      sessionId,
      // 4 minutes ago — well within the 60-minute suspicion window.
      mtimeMs: now.getTime() - 4 * 60 * 1000,
      entries: [
        { type: "assistant", timestamp: new Date(now.getTime() - 5 * 60 * 1000).toISOString() },
        {
          type: "assistant",
          timestamp: new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
          message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
        },
      ],
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(),
      claudeLocalProjectsDir: projectsRoot,
    });

    const result = await recovery.scanSilentActiveRuns({ now });

    expect(result.scanned).toBe(1);
    expect(result.created).toBe(0);
    expect(result.transcriptAlive).toBe(1);
    const evals = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stale_active_run_evaluation"));
    expect(evals).toHaveLength(0);
  });

  it("still raises a review issue for claude_local when the JSONL transcript is itself stale, and includes the tail in the body", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const sessionId = randomUUID();
    await seedRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      adapterType: "claude_local",
      sessionId,
    });
    await writeTranscriptFile({
      sessionId,
      // 90 minutes ago — beyond the 60-minute suspicion window.
      mtimeMs: now.getTime() - 90 * 60 * 1000,
      entries: [
        {
          type: "assistant",
          timestamp: new Date(now.getTime() - 95 * 60 * 1000).toISOString(),
          message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
        },
        {
          type: "assistant",
          timestamp: new Date(now.getTime() - 92 * 60 * 1000).toISOString(),
          message: { content: [{ type: "tool_use", name: "Edit", input: {} }] },
        },
        {
          type: "assistant",
          timestamp: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
          message: { content: [{ type: "tool_use", name: "Grep", input: {} }] },
        },
      ],
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(),
      claudeLocalProjectsDir: projectsRoot,
      pidIsAlive: () => true,
    });

    const result = await recovery.scanSilentActiveRuns({ now });

    expect(result.created).toBe(1);
    expect(result.transcriptAlive).toBe(0);
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stale_active_run_evaluation"));
    expect(evaluation).toBeTruthy();
    expect(evaluation?.description).toContain("## Claude Local Transcript");
    expect(evaluation?.description).toContain("Last tool_use: Grep");
    expect(evaluation?.description).toContain("tool_use: Read");
  });

  it("does not consult the JSONL transcript for non-claude_local adapters and creates the review issue as before", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const sessionId = randomUUID();
    await seedRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      adapterType: "codex_local",
      sessionId,
    });
    // Write a fresh transcript that *would* mark a claude_local run alive.
    await writeTranscriptFile({
      sessionId,
      mtimeMs: now.getTime() - 60 * 1000,
      entries: [{ type: "assistant", timestamp: new Date().toISOString() }],
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(),
      claudeLocalProjectsDir: projectsRoot,
    });

    const result = await recovery.scanSilentActiveRuns({ now });

    expect(result.created).toBe(1);
    expect(result.transcriptAlive).toBe(0);
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stale_active_run_evaluation"));
    expect(evaluation).toBeTruthy();
    expect(evaluation?.description).not.toContain("## Claude Local Transcript");
  });

  it("raises a review issue for claude_local with no transcript at all and reports the dead-pid signal", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const sessionId = randomUUID();
    const { runId } = await seedRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      adapterType: "claude_local",
      sessionId,
    });
    // Set a pid that the injected probe will report as not-alive.
    await db.update(heartbeatRuns).set({ processPid: 999999 }).where(eq(heartbeatRuns.id, runId));
    // Intentionally do NOT write a transcript file.
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(),
      claudeLocalProjectsDir: projectsRoot,
      pidIsAlive: () => false,
    });

    const result = await recovery.scanSilentActiveRuns({ now });

    expect(result.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stale_active_run_evaluation"));
    expect(evaluation?.description).toContain("## Claude Local Transcript");
    expect(evaluation?.description).toContain("Transcript path: _not located_");
    expect(evaluation?.description).toContain("alive: no");
  });
});
