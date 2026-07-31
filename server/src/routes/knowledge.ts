import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { knowledgeService, logActivity } from "../services/index.js";
import { syncKnowledgeFiles } from "../services/knowledge-sync.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const knowledge = knowledgeService(db);

  router.get("/companies/:companyId/knowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const docs = await knowledge.listRecent(companyId, limit, offset);
    res.json({ items: docs, limit, offset });
  });

  router.get("/companies/:companyId/knowledge/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await knowledge.stats(companyId));
  });

  router.get("/companies/:companyId/knowledge/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const q = String(req.query.q ?? "").trim();
    if (!q) throw badRequest("missing 'q' query parameter");
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const hits = await knowledge.search(companyId, q, limit);
    res.json({ query: q, hits });
  });

  router.get("/companies/:companyId/knowledge/:docId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const doc = await knowledge.getById(req.params.docId as string);
    if (!doc || doc.companyId !== companyId) throw notFound("wiki document not found");
    res.json(doc);
  });

  router.put("/companies/:companyId/knowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body ?? {};
    if (!body.title || !body.body) throw badRequest("title and body required");
    const actor = getActorInfo(req);
    const doc = await knowledge.upsertWikiDocument({
      id: body.id,
      companyId,
      title: String(body.title),
      body: String(body.body),
      summary: body.summary ?? null,
      kind: body.kind,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      decayTier: body.decayTier,
      sourceIssueId: body.sourceIssueId ?? null,
      byUserId: actor.actorType === "user" ? actor.actorId : null,
      byAgentId: actor.actorType === "agent" ? actor.agentId : null,
    });
    if (!doc) throw notFound("wiki document not found");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: body.id ? "knowledge.updated" : "knowledge.created",
      entityType: "document",
      entityId: doc.id,
      details: { title: doc.title, kind: doc.kind },
    });
    res.json(doc);
  });

  router.post("/companies/:companyId/knowledge/:docId/reinforce", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const doc = await knowledge.getById(req.params.docId as string);
    if (!doc || doc.companyId !== companyId) throw notFound("wiki document not found");
    const updated = await knowledge.reinforce(doc.id);
    res.json(updated);
  });

  router.post("/companies/:companyId/knowledge/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const stats = await syncKnowledgeFiles(db, companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "knowledge.synced",
      entityType: "company",
      entityId: companyId,
      details: stats,
    });
    res.json(stats);
  });

  router.post("/companies/:companyId/knowledge/crystallize", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issueId = String(req.body?.issueId ?? "").trim();
    if (!issueId) throw badRequest("missing 'issueId' in body");
    const created = await knowledge.crystallize(companyId, issueId);
    const actor = getActorInfo(req);
    if (created.length > 0) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "knowledge.crystallized",
        entityType: "issue",
        entityId: issueId,
        details: { docsCreated: created.length, titles: created.map((d) => d.title) },
      });
    }
    res.json({ created });
  });

  return router;
}
