#!/usr/bin/env -S node --import tsx
/**
 * PPC-7681 item 2: sweep the existing run-log files for live credential
 * values the writer wrote before redact-on-write (PPC-7681 item 1) landed.
 *
 * Deliberately NOT a blind find-and-replace over the filesystem: run logs are
 * append-only platform data a live agent run may still be writing to, and
 * `heartbeat.ts` reads/ranges them for the transcript UI while a run is
 * active. Rewriting a file a live run is mid-append to would race the
 * appender and corrupt or lose the tail. So every file is checked against
 * `heartbeat_runs` first, and anything not provably finished is skipped and
 * left for a later pass rather than guessed at.
 *
 * Usage:
 *   node --import tsx scripts/sweep-run-log-secrets.ts [--dry-run] [--root <dir>]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { resolvePaperclipInstanceRoot } from "../server/src/home-paths.js";
import { redactKnownSecretValues, RunLogRedactionUnavailableError } from "../server/src/services/run-log-secret-redaction.js";

interface RunRow {
  logRef: string;
  status: string;
  finishedAt: Date | null;
}

// A run row not yet finished (no finishedAt) may still be appending, no
// matter what `status` says -- `finishedAt` is set by `finalize()`, the same
// call that retires the in-flight S3 mirror, so it is the one field that
// means "this file will never grow again".
function isSafeToRewrite(row: RunRow | undefined, fileMtimeMs: number, now: number): { ok: boolean; reason: string } {
  if (row) {
    if (!row.finishedAt) return { ok: false, reason: `run not finished (status=${row.status})` };
    return { ok: true, reason: "run finalized" };
  }
  // No DB row -- an older run, or the DB was reset/restored separately from
  // the log tree. Fall back to a conservative quiet-period heuristic: a file
  // untouched for a good while is not being actively appended to.
  const QUIET_PERIOD_MS = 30 * 60_000;
  if (now - fileMtimeMs < QUIET_PERIOD_MS) {
    return { ok: false, reason: "no DB row and modified recently" };
  }
  return { ok: true, reason: "no DB row, quiet > 30min" };
}

async function walkNdjson(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function redactLine(line: string): { line: string; changed: boolean } {
  if (line === "") return { line, changed: false };
  try {
    const parsed = JSON.parse(line) as { chunk?: unknown; [key: string]: unknown };
    if (typeof parsed.chunk === "string") {
      const redactedChunk = redactKnownSecretValues(parsed.chunk);
      if (redactedChunk !== parsed.chunk) {
        parsed.chunk = redactedChunk;
        return { line: JSON.stringify(parsed), changed: true };
      }
      return { line, changed: false };
    }
    return { line, changed: false };
  } catch {
    // Unparsable line (truncated/corrupt record): don't attempt to rewrite
    // its structure, but still run the raw text through the redactor so a
    // live value sitting in a broken line is not left behind.
    const redacted = redactKnownSecretValues(line);
    return { line: redacted, changed: redacted !== line };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rootArgIndex = args.indexOf("--root");
  const root = rootArgIndex >= 0 && args[rootArgIndex + 1]
    ? path.resolve(args[rootArgIndex + 1]!)
    : path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");

  // Fail loud and fast, exactly like the writer: if the credential source
  // can't be loaded, there is nothing safe to sweep against.
  try {
    redactKnownSecretValues("");
  } catch (err) {
    if (err instanceof RunLogRedactionUnavailableError) {
      console.error(`[sweep] cannot load credential source, aborting: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const runsByLogRef = new Map<string, RunRow>();
  try {
    const rows = await db.$client<{ log_ref: string; status: string; finished_at: Date | null }[]>`
      SELECT log_ref, status, finished_at
      FROM heartbeat_runs
      WHERE log_ref IS NOT NULL
    `;
    for (const row of rows) {
      runsByLogRef.set(row.log_ref, { logRef: row.log_ref, status: row.status, finishedAt: row.finished_at });
    }
  } finally {
    await db.$client.end({ timeout: 1 });
  }

  const files = await walkNdjson(root);
  const now = Date.now();
  let changedCount = 0;
  let skippedInFlight = 0;
  let skippedUnknownRecent = 0;
  let unchangedCount = 0;
  const changedVarNames = new Set<string>();

  for (const absPath of files) {
    const relPath = path.relative(root, absPath);
    const row = runsByLogRef.get(relPath);
    const stat = await fs.stat(absPath);
    const { ok, reason } = isSafeToRewrite(row, stat.mtimeMs, now);
    if (!ok) {
      if (reason.startsWith("run not finished")) skippedInFlight += 1;
      else skippedUnknownRecent += 1;
      continue;
    }

    const original = await fs.readFile(absPath, "utf8");
    const lines = original.split("\n");
    let fileChanged = false;
    const nextLines = lines.map((line) => {
      const { line: nextLine, changed } = redactLine(line);
      if (changed) {
        fileChanged = true;
        for (const match of nextLine.matchAll(/\*\*\*REDACTED:([A-Z0-9_]+(?:\|[A-Z0-9_]+)*)\*\*\*/g)) {
          for (const name of match[1]!.split("|")) changedVarNames.add(name);
        }
      }
      return nextLine;
    });

    if (!fileChanged) {
      unchangedCount += 1;
      continue;
    }

    const nextContent = nextLines.join("\n");
    // Self-check before writing: the rewritten content must not still
    // contain any known live value. A redactor that reports "changed" while
    // leaving a residual match would be worse than doing nothing silently.
    const stillLeaky = redactKnownSecretValues(nextContent) !== nextContent;
    if (stillLeaky) {
      console.error(`[sweep] REFUSING to write ${relPath}: post-redaction self-check still found a live value`);
      continue;
    }

    changedCount += 1;
    if (dryRun) continue;

    const tmpPath = `${absPath}.redact-tmp-${process.pid}`;
    await fs.writeFile(tmpPath, nextContent, { encoding: "utf8", mode: stat.mode });
    await fs.rename(tmpPath, absPath);
  }

  console.log(JSON.stringify({
    root,
    dryRun,
    filesScanned: files.length,
    filesChanged: changedCount,
    filesUnchanged: unchangedCount,
    filesSkippedInFlight: skippedInFlight,
    filesSkippedUnknownRecent: skippedUnknownRecent,
    distinctCredentialNamesRedacted: [...changedVarNames].sort(),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
