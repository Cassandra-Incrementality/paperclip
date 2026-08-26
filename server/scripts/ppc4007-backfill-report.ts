import { createDb } from "../../packages/db/src/index.js";
import { loadConfig } from "../src/config.js";
import { sql } from "drizzle-orm";

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  // PPC-4007 AC4: count currently-open issues whose active episode
  // (issues.started_at, falling back to execution_locked_at) is older than 48h
  // and that have had zero heartbeat_runs in the trailing 6 hours -- mirrors the
  // new hasLiveExecutionPath suppression condition in productivity-review.ts,
  // scoped to the assignee agent the way collectEvidence() does.
  const rows = await db.execute(sql`
    select
      i.company_id,
      count(*)::int as stale_count
    from issues i
    where i.status = 'in_progress'
      and i.assignee_agent_id is not null
      and i.assignee_user_id is null
      and i.hidden_at is null
      and coalesce(i.started_at, i.execution_locked_at) is not null
      and coalesce(i.started_at, i.execution_locked_at) <= now() - interval '48 hours'
      and not exists (
        select 1
        from heartbeat_runs hr
        where hr.company_id = i.company_id
          and hr.agent_id = i.assignee_agent_id
          and (
            hr.context_snapshot ->> 'issueId' = i.id::text
            or hr.context_snapshot ->> 'taskId' = i.id::text
            or hr.context_snapshot ->> 'taskKey' = i.id::text
          )
          and coalesce(hr.started_at, hr.created_at) >= now() - interval '6 hours'
      )
    group by i.company_id
    order by stale_count desc
  `);

  const typedRows = rows as unknown as Array<{ company_id: string; stale_count: number }>;
  const total = typedRows.reduce((sum, row) => sum + row.stale_count, 0);
  console.log(JSON.stringify({ total, byCompany: typedRows }, null, 2));
}

void main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
