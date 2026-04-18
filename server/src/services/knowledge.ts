import { and, desc, eq, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@paperclipai/db";
import { documents, issueComments, issues } from "@paperclipai/db";

const MODEL = "claude-haiku-4-5-20251001";
const CRYSTALLIZE_MAX_DOCS = 3;
const CRYSTALLIZE_MAX_INPUT_CHARS = 60_000;
const SEARCH_DEFAULT_LIMIT = 20;
const CONTEXT_DEFAULT_LIMIT = 5;
const CONTEXT_MIN_SIMILARITY = 0.05;

const DECAY_TIERS = ["working", "episodic", "semantic", "procedural"] as const;
const KINDS = ["manual", "crystallized", "procedural", "reference"] as const;

export type WikiKind = (typeof KINDS)[number];
export type DecayTier = (typeof DECAY_TIERS)[number];

export interface WikiDocument {
  id: string;
  companyId: string;
  title: string | null;
  summary: string | null;
  body: string;
  kind: string;
  tags: string[] | null;
  confidence: number;
  sourceCount: number;
  decayTier: string;
  lastReinforcedAt: Date | null;
  supersededById: string | null;
  sourceIssueId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertWikiDocumentInput {
  id?: string;
  companyId: string;
  title: string;
  body: string;
  summary?: string | null;
  kind?: WikiKind;
  tags?: string[];
  decayTier?: DecayTier;
  sourceIssueId?: string | null;
  byUserId?: string | null;
  byAgentId?: string | null;
}

export interface SearchHit {
  id: string;
  title: string | null;
  summary: string | null;
  kind: string;
  tags: string[] | null;
  confidence: number;
  sourceCount: number;
  decayTier: string;
  similarity: number;
  updatedAt: Date;
}

const CRYSTALLIZE_SYSTEM_PROMPT = `You distill completed work into wiki knowledge entries for an organizational AI brain.

Given an issue's title, description, and conversation thread, extract 0–${CRYSTALLIZE_MAX_DOCS} reusable knowledge entries that future agents working on similar problems would benefit from. Skip the issue entirely if it produced no durable, transferable knowledge (one-off chores, conversational threads, etc.).

Each entry should be:
- A reusable lesson, decision, fact, procedure, or convention — NOT a status update or a recap of what happened
- Self-contained (a future agent should understand it without reading the source issue)
- Specific (concrete examples, file paths, commands, numbers, names) — generic advice is useless

Return STRICT JSON matching this schema (no prose around it, no markdown fences):

{
  "entries": [
    {
      "title": "<short imperative title, <=80 chars>",
      "summary": "<1-2 sentence summary, <=240 chars>",
      "body": "<full markdown body, can include code blocks, lists, links>",
      "kind": "crystallized" | "procedural" | "reference",
      "tags": ["<tag>", ...],
      "confidence": <0.0-1.0>
    }
  ]
}

Return {"entries": []} if nothing is worth saving. Use "crystallized" for conclusions/decisions, "procedural" for how-to recipes, "reference" for facts/specs/links.`;

export function knowledgeService(db: Db) {
  function getApiKey(): string | null {
    return process.env.ANTHROPIC_API_KEY ?? null;
  }

  async function search(
    companyId: string,
    query: string,
    limit = SEARCH_DEFAULT_LIMIT,
    minSimilarity = 0,
  ): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const rows = await db
      .select({
        id: documents.id,
        title: documents.title,
        summary: documents.summary,
        kind: documents.kind,
        tags: documents.tags,
        confidence: documents.confidence,
        sourceCount: documents.sourceCount,
        decayTier: documents.decayTier,
        updatedAt: documents.updatedAt,
        similarity: sql<number>`GREATEST(
          similarity(coalesce(${documents.title}, ''), ${trimmed}),
          similarity(coalesce(${documents.summary}, ''), ${trimmed}),
          similarity(coalesce(${documents.latestBody}, ''), ${trimmed}) * 0.6
        )`.as("similarity"),
      })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, companyId),
          sql`${documents.supersededById} IS NULL`,
        ),
      )
      .orderBy(desc(sql`similarity`), desc(documents.updatedAt))
      .limit(limit);

    return rows
      .filter((r) => Number(r.similarity) >= minSimilarity)
      .map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        kind: r.kind,
        tags: r.tags,
        confidence: Number(r.confidence),
        sourceCount: r.sourceCount,
        decayTier: r.decayTier,
        similarity: Number(r.similarity),
        updatedAt: r.updatedAt,
      }));
  }

  async function getContextForTask(
    companyId: string,
    taskTitle: string,
    extraSignals: string[] = [],
    limit = CONTEXT_DEFAULT_LIMIT,
  ): Promise<SearchHit[]> {
    const query = [taskTitle, ...extraSignals].filter(Boolean).join(" ").slice(0, 500);
    return search(companyId, query, limit, CONTEXT_MIN_SIMILARITY);
  }

  async function listRecent(companyId: string, limit = 50, offset = 0) {
    return db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.companyId, companyId),
          sql`${documents.supersededById} IS NULL`,
        ),
      )
      .orderBy(desc(documents.updatedAt))
      .limit(limit)
      .offset(offset);
  }

  async function getById(id: string) {
    return db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function upsertWikiDocument(input: UpsertWikiDocumentInput) {
    const now = new Date();
    if (input.id) {
      const existing = await getById(input.id);
      if (!existing || existing.companyId !== input.companyId) return null;
      const updated = await db
        .update(documents)
        .set({
          title: input.title,
          latestBody: input.body,
          summary: input.summary ?? null,
          kind: input.kind ?? existing.kind,
          tags: input.tags ?? existing.tags,
          decayTier: input.decayTier ?? existing.decayTier,
          sourceIssueId: input.sourceIssueId ?? existing.sourceIssueId,
          updatedByUserId: input.byUserId ?? null,
          updatedByAgentId: input.byAgentId ?? null,
          updatedAt: now,
          latestRevisionNumber: existing.latestRevisionNumber + 1,
        })
        .where(eq(documents.id, input.id))
        .returning();
      return updated[0] ?? null;
    }
    const inserted = await db
      .insert(documents)
      .values({
        companyId: input.companyId,
        title: input.title,
        latestBody: input.body,
        summary: input.summary ?? null,
        kind: input.kind ?? "manual",
        tags: input.tags ?? null,
        decayTier: input.decayTier ?? "episodic",
        sourceIssueId: input.sourceIssueId ?? null,
        createdByUserId: input.byUserId ?? null,
        createdByAgentId: input.byAgentId ?? null,
        updatedByUserId: input.byUserId ?? null,
        updatedByAgentId: input.byAgentId ?? null,
      })
      .returning();
    return inserted[0] ?? null;
  }

  async function reinforce(id: string) {
    const updated = await db
      .update(documents)
      .set({
        sourceCount: sql`${documents.sourceCount} + 1`,
        lastReinforcedAt: new Date(),
        confidence: sql`LEAST(1.0, ${documents.confidence} + 0.05)`,
      })
      .where(eq(documents.id, id))
      .returning();
    return updated[0] ?? null;
  }

  function buildIssueTranscript(
    issue: { title: string; description: string | null },
    comments: Array<{ body: string; createdAt: Date; authorAgentId: string | null; authorUserId: string | null }>,
  ): string {
    const parts: string[] = [];
    parts.push(`# Issue: ${issue.title}`);
    if (issue.description) parts.push(`\n## Description\n${issue.description}`);
    parts.push(`\n## Comment Thread (${comments.length} comments)`);
    for (const c of comments) {
      const who = c.authorAgentId ? `agent:${c.authorAgentId.slice(0, 8)}` : c.authorUserId ? `user:${c.authorUserId.slice(0, 8)}` : "system";
      parts.push(`\n### ${who} @ ${c.createdAt.toISOString()}\n${c.body}`);
    }
    const joined = parts.join("\n");
    return joined.length > CRYSTALLIZE_MAX_INPUT_CHARS
      ? joined.slice(0, CRYSTALLIZE_MAX_INPUT_CHARS) + "\n[...truncated...]"
      : joined;
  }

  async function crystallize(companyId: string, issueId: string): Promise<WikiDocument[]> {
    const apiKey = getApiKey();
    if (!apiKey) return [];

    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) return [];

    const comments = await db
      .select({
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt);

    const transcript = buildIssueTranscript(
      { title: issue.title, description: issue.description },
      comments,
    );

    const client = new Anthropic({ apiKey });
    let raw: string;
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: CRYSTALLIZE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: transcript }],
      });
      const text = response.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      raw = text.trim();
    } catch (err) {
      console.error(`[knowledge] crystallize LLM call failed for issue ${issueId}:`, err);
      return [];
    }

    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return [];
    let parsed: { entries?: Array<{ title: string; summary: string; body: string; kind?: string; tags?: string[]; confidence?: number }> };
    try {
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return [];
    }
    const entries = (parsed.entries ?? []).slice(0, CRYSTALLIZE_MAX_DOCS);

    const created: WikiDocument[] = [];
    for (const entry of entries) {
      if (!entry.title || !entry.body) continue;
      const kind = (KINDS.includes(entry.kind as WikiKind) ? entry.kind : "crystallized") as WikiKind;
      const inserted = await db
        .insert(documents)
        .values({
          companyId,
          title: entry.title.slice(0, 200),
          latestBody: entry.body,
          summary: entry.summary?.slice(0, 500) ?? null,
          kind,
          tags: entry.tags ?? null,
          confidence: typeof entry.confidence === "number" ? Math.min(1, Math.max(0, entry.confidence)) : 0.7,
          decayTier: kind === "procedural" ? "procedural" : kind === "reference" ? "semantic" : "episodic",
          sourceIssueId: issueId,
          sourceCount: 1,
        })
        .returning();
      const row = inserted[0];
      if (row) {
        created.push(toWikiDoc(row));
      }
    }
    return created;
  }

  function toWikiDoc(row: typeof documents.$inferSelect): WikiDocument {
    return {
      id: row.id,
      companyId: row.companyId,
      title: row.title,
      summary: row.summary,
      body: row.latestBody,
      kind: row.kind,
      tags: row.tags,
      confidence: Number(row.confidence),
      sourceCount: row.sourceCount,
      decayTier: row.decayTier,
      lastReinforcedAt: row.lastReinforcedAt,
      supersededById: row.supersededById,
      sourceIssueId: row.sourceIssueId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function stats(companyId: string) {
    const rows = await db
      .select({
        kind: documents.kind,
        decayTier: documents.decayTier,
        count: sql<number>`count(*)::int`,
      })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, companyId),
          sql`${documents.supersededById} IS NULL`,
        ),
      )
      .groupBy(documents.kind, documents.decayTier);
    const byKind: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.count;
      byTier[r.decayTier] = (byTier[r.decayTier] ?? 0) + r.count;
      total += r.count;
    }
    return { total, byKind, byTier, details: rows };
  }

  return {
    search,
    getContextForTask,
    listRecent,
    getById,
    upsertWikiDocument,
    reinforce,
    crystallize,
    stats,
  };
}

export type KnowledgeService = ReturnType<typeof knowledgeService>;
