import { pgTable, uuid, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const issueCommentDigests = pgTable(
  "issue_comment_digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** The markdown digest text produced by the LLM. Null if never generated. */
    digest: text("digest"),
    /** ID of the last comment included in this digest. */
    digestedThrough: uuid("digested_through").references(() => issueComments.id, { onDelete: "set null" }),
    /** Number of comments that were summarised into the digest. */
    digestedCount: integer("digested_count").notNull().default(0),
    /** Model used to produce the digest. */
    model: text("model"),
    /** Cost of the last LLM call in cents (fractional rounded up). */
    costCents: integer("cost_cents").notNull().default(0),
    /**
     * Mutex timestamp — set to `now()` before an LLM call begins, cleared
     * (set to null) when the call completes. If non-null and < 2 min ago,
     * a concurrent caller should skip regen.
     */
    generatingAt: timestamp("generating_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("issue_comment_digests_issue_uq").on(table.issueId),
    companyIdx: index("issue_comment_digests_company_idx").on(table.companyId),
  }),
);
