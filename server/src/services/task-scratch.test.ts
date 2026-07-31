import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
} from "./run-scratch.js";
import {
  HEARTBEAT_TASK_SCRATCH_MARKER,
  prepareHeartbeatTaskScratch,
  pruneStaleHeartbeatTaskScratch,
  taskScratchDirForIssue,
  taskScratchRoot,
} from "./task-scratch.js";

const cleanupDirs = new Set<string>();

function trackIssue(issueId: string): string {
  const dir = taskScratchDirForIssue(issueId);
  cleanupDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  cleanupDirs.clear();
});

describe("heartbeat task scratch durability", () => {
  it("survives a run that terminates non-gracefully and resolves to the same path on the next run", async () => {
    const issueId = randomUUID();
    trackIssue(issueId);

    // First run: prepare a task scratch dir and checkpoint a file into it.
    const firstRunTaskScratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId,
      issueIdentifier: "PAP-3305",
      now: new Date("2026-07-31T00:00:00.000Z"),
    });
    await fs.writeFile(path.join(firstRunTaskScratch.dir, "checkpoint.json"), '{"progress":42}');

    // The same run also has a run-scoped scratch dir, which the heartbeat
    // cleanup path removes on any terminal status, including failure.
    const runScratch = await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId,
      issueIdentifier: "PAP-3305",
    });
    await fs.writeFile(path.join(runScratch.dir, "run-local.txt"), "ephemeral");
    const cleanup = await cleanupHeartbeatRunScratch({ scratch: runScratch });
    expect(cleanup).toEqual({ removed: true, dir: runScratch.dir });

    // The task scratch checkpoint must have survived the run's death.
    const checkpointAfterFailure = await fs.readFile(
      path.join(firstRunTaskScratch.dir, "checkpoint.json"),
      "utf8",
    );
    expect(checkpointAfterFailure).toBe('{"progress":42}');

    // Second run on the same issue: resolves to the identical path and can
    // read back what the first run left behind.
    const secondRunTaskScratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId,
      issueIdentifier: "PAP-3305",
      now: new Date("2026-07-31T01:00:00.000Z"),
    });
    expect(secondRunTaskScratch.dir).toBe(firstRunTaskScratch.dir);
    const checkpointFromSecondRun = await fs.readFile(
      path.join(secondRunTaskScratch.dir, "checkpoint.json"),
      "utf8",
    );
    expect(checkpointFromSecondRun).toBe('{"progress":42}');
    expect(secondRunTaskScratch.metadata.createdAt).toBe(firstRunTaskScratch.metadata.createdAt);
    expect(secondRunTaskScratch.metadata.lastTouchedAt).not.toBe(firstRunTaskScratch.metadata.lastTouchedAt);
  });

  it("is not touched by run-scratch cleanup even when they share an issue", async () => {
    const issueId = randomUUID();
    const taskDir = trackIssue(issueId);

    await prepareHeartbeatTaskScratch({ companyId: "company-1", issueId });
    const runScratch = await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId,
    });

    await cleanupHeartbeatRunScratch({ scratch: runScratch });

    await expect(fs.stat(taskDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});

describe("heartbeat task scratch retention sweep", () => {
  it("reaps task scratch dirs untouched for longer than the retention window", async () => {
    const staleIssueId = randomUUID();
    const freshIssueId = randomUUID();
    const staleDir = trackIssue(staleIssueId);
    const freshDir = trackIssue(freshIssueId);

    await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId: staleIssueId,
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId: freshIssueId,
      now: new Date("2026-07-30T00:00:00.000Z"),
    });

    const result = await pruneStaleHeartbeatTaskScratch({
      retentionDays: 14,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result.removedDirs).toContain(staleDir);
    expect(result.removedDirs).not.toContain(freshDir);
    await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(freshDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("resets the retention clock every time a run touches the issue", async () => {
    const issueId = randomUUID();
    const dir = trackIssue(issueId);

    await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId,
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    // A later run starts and re-touches the marker before the retention
    // window would otherwise have expired it.
    await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      issueId,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    const result = await pruneStaleHeartbeatTaskScratch({
      retentionDays: 14,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result.removedDirs).not.toContain(dir);
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("leaves directories without a valid task-scratch marker alone", async () => {
    const root = taskScratchRoot();
    await fs.mkdir(root, { recursive: true });
    const unmarkedDir = await fs.mkdtemp(path.join(root, "unmarked-"));
    cleanupDirs.add(unmarkedDir);

    const result = await pruneStaleHeartbeatTaskScratch({ retentionDays: 0 });

    expect(result.removedDirs).not.toContain(unmarkedDir);
    await expect(fs.stat(unmarkedDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});

describe("task scratch marker", () => {
  it("writes a marker file with a stable name inside the task dir", async () => {
    const issueId = randomUUID();
    trackIssue(issueId);
    const scratch = await prepareHeartbeatTaskScratch({ companyId: "company-1", issueId });
    await expect(fs.stat(path.join(scratch.dir, HEARTBEAT_TASK_SCRATCH_MARKER))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });
});
