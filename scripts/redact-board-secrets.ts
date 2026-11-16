#!/usr/bin/env -S node --import tsx
/**
 * PPC-7681 item 3: redact live credential values out of `issue_comments`,
 * `documents.latest_body` and `document_revisions.body`.
 *
 * `issue_comments` has no PATCH route (API offers only DELETE, which would
 * destroy the row's reasoning along with the value) and a document's old
 * revisions aren't editable through the API at all, so this goes straight at
 * Postgres. In place, not a new revision: the ask is to remove the live
 * value from board HISTORY, and a fresh "redaction" revision would still
 * leave the original leaking.
 *
 * Exact-value cross-reference against .env.ads, the same classification as
 * the run-log writer (run-log-secret-redaction.ts) and
 * scripts/secret_value_scan.py, so "live credential" means one thing
 * company-wide.
 *
 * Usage:
 *   node --import tsx scripts/redact-board-secrets.ts [--dry-run]
 */
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { redactKnownSecretValues, RunLogRedactionUnavailableError } from "../server/src/services/run-log-secret-redaction.js";

interface TableSpec {
  table: string;
  idCol: string;
  bodyCol: string;
}

const TABLES: TableSpec[] = [
  { table: "issue_comments", idCol: "id", bodyCol: "body" },
  { table: "documents", idCol: "id", bodyCol: "latest_body" },
  { table: "document_revisions", idCol: "id", bodyCol: "body" },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Loud-fail exactly like the writer: no credential source, nothing to do.
  try {
    redactKnownSecretValues("");
  } catch (err) {
    if (err instanceof RunLogRedactionUnavailableError) {
      console.error(`[redact-board] cannot load credential source, aborting: ${err.message}`);
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

  const summary: Array<{ table: string; id: string; namesRedacted: string[] }> = [];

  try {
    for (const spec of TABLES) {
      const rows = await db.$client<{ id: string; body: string }[]>`
        SELECT ${db.$client(spec.idCol)} AS id, ${db.$client(spec.bodyCol)} AS body
        FROM ${db.$client(spec.table)}
      `;

      for (const row of rows) {
        if (!row.body) continue;
        const redacted = redactKnownSecretValues(row.body);
        if (redacted === row.body) continue;

        const names = new Set<string>();
        for (const match of redacted.matchAll(/\*\*\*REDACTED:([A-Z0-9_]+(?:\|[A-Z0-9_]+)*)\*\*\*/g)) {
          for (const name of match[1]!.split("|")) names.add(name);
        }

        // Self-check: never write a result that still carries a live value.
        if (redactKnownSecretValues(redacted) !== redacted) {
          console.error(`[redact-board] REFUSING ${spec.table}/${row.id}: still leaky after redaction`);
          continue;
        }

        summary.push({ table: spec.table, id: row.id, namesRedacted: [...names].sort() });

        if (!dryRun) {
          await db.$client`
            UPDATE ${db.$client(spec.table)}
            SET ${db.$client(spec.bodyCol)} = ${redacted}
            WHERE ${db.$client(spec.idCol)} = ${row.id}
          `;
        }
      }
    }
  } finally {
    await db.$client.end({ timeout: 1 });
  }

  const byTable = new Map<string, number>();
  const allNames = new Set<string>();
  for (const row of summary) {
    byTable.set(row.table, (byTable.get(row.table) ?? 0) + 1);
    row.namesRedacted.forEach((name) => allNames.add(name));
  }

  console.log(JSON.stringify({
    dryRun,
    rowsRedacted: summary.length,
    byTable: Object.fromEntries(byTable),
    distinctCredentialNamesRedacted: [...allNames].sort(),
    rows: summary.map(({ table, id, namesRedacted }) => ({ table, id, namesRedacted })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
