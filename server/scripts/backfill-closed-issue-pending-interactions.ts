import { and, eq, inArray } from "drizzle-orm";
import { companies, createDb, issues, issueThreadInteractions } from "../../packages/db/src/index.js";
import { loadConfig } from "../src/config.js";
import { issueThreadInteractionService } from "../src/services/issue-thread-interactions.js";

const TERMINAL_STATUSES = ["done", "cancelled"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

// One-shot backfill for PPC-7648: closure-expiry (expirePendingInteractionsForTerminalIssue)
// only runs on the status-CHANGE event, so issues that closed before that code landed
// (~2026-07-31) were never swept. This re-invokes the exact same service function per
// already-terminal issue instead of hand-rolling the UPDATE.
async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const interactions = issueThreadInteractionService(db);
  const dryRun = hasFlag("--dry-run");
  const actorAgentId = parseFlag("--actor-agent-id");
  const companyId = parseFlag("--company");

  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  let totalIssues = 0;
  let totalExpired = 0;

  for (const company of companyRows) {
    const staleIssueIds = await db
      .selectDistinct({ id: issueThreadInteractions.issueId })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(and(
        eq(issueThreadInteractions.companyId, company.id),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issues.status, TERMINAL_STATUSES as unknown as string[]),
      ));

    if (staleIssueIds.length === 0) continue;

    const staleIssues = await db
      .select({ id: issues.id, companyId: issues.companyId, status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(inArray(issues.id, staleIssueIds.map((r) => r.id)));

    console.log(`Company ${company.id}: ${staleIssues.length} closed issue(s) with pending interactions.`);

    for (const issue of staleIssues) {
      if (dryRun) {
        console.log(`  [dry-run] would expire pending interactions on ${issue.identifier} (${issue.status})`);
        totalIssues += 1;
        continue;
      }
      const expired = await interactions.expirePendingInteractionsForTerminalIssue(
        { id: issue.id, companyId: issue.companyId, status: issue.status },
        actorAgentId ? { agentId: actorAgentId } : {},
      );
      console.log(`  ${issue.identifier} (${issue.status}): expired ${expired.length} interaction(s).`);
      totalIssues += 1;
      totalExpired += expired.length;
    }
  }

  if (dryRun) {
    console.log(`Dry run complete: ${totalIssues} issue(s) would be touched.`);
  } else {
    console.log(`Backfill complete: ${totalExpired} interaction(s) expired across ${totalIssues} issue(s).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Closed-issue pending-interaction backfill failed: ${message}`);
    process.exit(1);
  });
