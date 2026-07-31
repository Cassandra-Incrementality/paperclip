import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_TASK_SCRATCH_MARKER = ".paperclip-task-scratch.json";
export const HEARTBEAT_TASK_SCRATCH_ROOT_NAME = "paperclip-task-scratch";

/**
 * How long a task scratch dir survives with no run touching it. This is the
 * only reap path for task scratch — it is deliberately not tied to per-run
 * termination (see cleanupHeartbeatRunScratch for that) or to any single
 * issue-status-transition call site. An issue that finishes, or one that
 * simply goes idle without ever reaching a terminal status, both age out the
 * same way once nothing has started a run against it for this long.
 */
export const DEFAULT_TASK_SCRATCH_RETENTION_DAYS = 14;

export interface HeartbeatTaskScratchMetadata {
  version: 1;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  createdAt: string;
  lastTouchedAt: string;
}

export interface HeartbeatTaskScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatTaskScratchMetadata;
}

export interface HeartbeatTaskScratchPruneResult {
  scanned: number;
  removed: number;
  removedDirs: string[];
}

const ISSUE_SEGMENT_MAX_CHARS = 64;

function sanitizePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

export function taskScratchRoot(): string {
  return path.join(os.tmpdir(), HEARTBEAT_TASK_SCRATCH_ROOT_NAME);
}

export function taskScratchDirForIssue(issueId: string): string {
  return path.join(taskScratchRoot(), sanitizePathSegment(issueId, "issue"));
}

async function readMarker(markerPath: string): Promise<HeartbeatTaskScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.issueId !== "string" ||
      typeof rec.createdAt !== "string" ||
      typeof rec.lastTouchedAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      issueId: rec.issueId,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
      lastTouchedAt: rec.lastTouchedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Prepare the task-durable scratch directory for an issue: create it if
 * missing, or resolve-and-touch it if a prior run already created it.
 *
 * Unlike run scratch, this directory:
 * - is keyed on issueId (not runId), so every run of the same issue
 *   resolves to the same path;
 * - is created with a plain recursive mkdir, not mkdtemp, so the path is
 *   deterministic instead of random;
 * - is never removed by run cleanup, including on a failed/killed run —
 *   only pruneStaleHeartbeatTaskScratch reaps it, based on age since last
 *   touch.
 */
export async function prepareHeartbeatTaskScratch(input: {
  companyId: string;
  issueId: string;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatTaskScratch> {
  const dir = taskScratchDirForIssue(input.issueId);
  const markerPath = path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER);
  await fs.mkdir(dir, { recursive: true });
  const now = (input.now ?? new Date()).toISOString();
  const existing = await readMarker(markerPath);
  const metadata: HeartbeatTaskScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier ?? existing?.issueIdentifier ?? null,
    createdAt: existing?.createdAt ?? now,
    lastTouchedAt: now,
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

/**
 * Reap task scratch directories that have not been touched (by a run
 * starting for their issue) within retentionDays. Directories without a
 * valid marker are left alone — they are not ours to remove.
 */
export async function pruneStaleHeartbeatTaskScratch(
  input: { retentionDays?: number; now?: Date } = {},
): Promise<HeartbeatTaskScratchPruneResult> {
  const retentionDays = input.retentionDays ?? DEFAULT_TASK_SCRATCH_RETENTION_DAYS;
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const root = taskScratchRoot();

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, removed: 0, removedDirs: [] };
    }
    throw err;
  }

  let removed = 0;
  const removedDirs: string[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const marker = await readMarker(path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER));
    if (!marker) continue;
    const touchedMs = Date.parse(marker.lastTouchedAt);
    if (Number.isNaN(touchedMs) || touchedMs > cutoffMs) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed++;
    removedDirs.push(dir);
  }

  return { scanned: entries.length, removed, removedDirs };
}

export interface HeartbeatTaskScratchSweepLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Start the periodic sweep that enforces the task scratch retention policy.
 * Runs once immediately, then on intervalMs, mirroring startPluginLogRetention.
 */
export function startHeartbeatTaskScratchRetentionSweep(input: {
  intervalMs?: number;
  retentionDays?: number;
  logger?: HeartbeatTaskScratchSweepLogger;
} = {}): () => void {
  const intervalMs = input.intervalMs ?? 6 * 60 * 60 * 1000;
  const retentionDays = input.retentionDays ?? DEFAULT_TASK_SCRATCH_RETENTION_DAYS;

  const run = () => {
    pruneStaleHeartbeatTaskScratch({ retentionDays })
      .then((result) => {
        if (result.removed > 0) {
          input.logger?.info(result, "Pruned stale task scratch directories");
        }
      })
      .catch((err) => {
        input.logger?.warn({ err }, "Task scratch retention sweep failed");
      });
  };

  const timer = setInterval(run, intervalMs);
  run();
  return () => clearInterval(timer);
}
