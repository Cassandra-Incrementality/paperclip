import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres astral-truncation regression test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PPC-7299: POST /api/issues/{id}/comments 500'd deterministically whenever the
// mandated "**TL;DR:** ... \n**\u{1F449} Needs you:** ..." header put the raw
// UTF-16 high surrogate of \u{1F449} at index 119 of the body (and the body was
// longer than 120 units): `comment.body.slice(0, 120)` (used as the activity-log
// `bodySnippet`) then ends in a lone high surrogate, which Postgres's json/jsonb
// input rejects with "invalid input syntax for type json" when logActivity
// writes `activity_log.details` -- after the comment row itself already
// committed, so the 500 was a false negative on an already-successful write.
// That non-atomicity is exactly what turned SEO Ops' live bisection on PPC-7275
// into a 90-comment burst. Fixed by truncating with `truncateByCodePoint`
// (whole-code-point iteration, never splits a surrogate pair) and by making the
// best-effort activity-log write non-fatal to the request.
describeEmbeddedPostgres("PPC-7299 comment post astral-character truncation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ppc7299-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PPC-7299 Repro Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "REPRO-1",
      title: "PPC-7299 repro target",
      status: "todo",
      priority: "medium",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return { companyId, issueId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  // Mandated Paperclip Agent Output Contract header, with a free-text TL;DR of
  // `tldrLen` chars so the \u{1F449} surrogate pair on line 2 lands at a
  // controlled raw UTF-16 offset in the body.
  function headerBody(tldrLen: number) {
    const tldr = "x".repeat(tldrLen);
    return [
      `**TL;DR:** ${tldr}`,
      `**\u{1F449} Needs you:** Nothing.`,
      `**Status:** on-track`,
    ].join("\n");
  }

  it("posts successfully when the \u{1F449} high surrogate falls exactly at body index 119", async () => {
    const { companyId, issueId } = await seedIssue();
    const app = createApp(companyId);

    // tldrLen=105 puts the high surrogate at index 119 -- the exact offset that
    // 500'd before this fix (comment.body.slice(0, 120) used to end there).
    const body = headerBody(105);
    expect(body.indexOf("\u{1F449}".charAt(0))).toBe(119);

    const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ body });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.body).toBe(body);

    const rows = await db.select().from(issueComments);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(body);

    const activity = await db.select().from(activityLog);
    const commentActivity = activity.find((row) => row.action === "issue.comment_added");
    expect(commentActivity).toBeDefined();
    const bodySnippet = (commentActivity?.details as { bodySnippet?: string } | null)?.bodySnippet;
    expect(bodySnippet).toBeDefined();
    // The snippet must never end in a lone (unpaired) high surrogate.
    const lastCode = bodySnippet!.charCodeAt(bodySnippet!.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it("never 500s across a sweep of \u{1F449} offsets around the former failure boundary", async () => {
    const { companyId, issueId } = await seedIssue();
    const app = createApp(companyId);

    for (let tldrLen = 100; tldrLen <= 125; tldrLen++) {
      const body = headerBody(tldrLen);
      const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ body });
      expect(res.status, `tldrLen=${tldrLen} body=${JSON.stringify(res.body)}`).toBe(201);
    }
  });
});
