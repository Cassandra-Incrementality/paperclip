import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { issueDocumentKeySchema, upsertIssueDocumentSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentService, documentService, goalService, logActivity, projectService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { ALLOWED_ENTITY_TYPES } from "../services/documents.js";
import { forbidden, notFound } from "../errors.js";

const entityTypeSchema = z.enum(ALLOWED_ENTITY_TYPES);

async function resolveEntityCompanyId(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const agentSvc = agentService(db);
  const projectSvc = projectService(db);
  const goalSvc = goalService(db);

  if (entityType === "agent") {
    const entity = await agentSvc.getById(entityId);
    return entity?.companyId ?? null;
  }
  if (entityType === "project") {
    const entity = await projectSvc.getById(entityId);
    return entity?.companyId ?? null;
  }
  if (entityType === "goal") {
    const entity = await goalSvc.getById(entityId);
    return entity?.companyId ?? null;
  }
  return null;
}

async function assertEntityWriteAccess(
  db: Db,
  req: Parameters<typeof getActorInfo>[0],
  entityType: string,
  entityId: string,
  companyId: string,
) {
  assertCompanyAccess(req, companyId);

  if (entityType !== "agent") return;

  const actor = req.actor;
  if (actor.type === "board") return;

  if (actor.type === "agent") {
    if (actor.agentId === entityId) return;

    const agentSvc = agentService(db);
    const chain = await agentSvc.getChainOfCommand(entityId);
    const isAncestor = chain.some((node) => node.id === actor.agentId);
    if (!isAncestor) {
      throw forbidden("Only the agent itself or an ancestor manager can write agent documents");
    }
  }
}

export function entityRoutes(db: Db) {
  const router = Router();
  const documentsSvc = documentService(db);

  async function resolveEntity(req: Parameters<typeof getActorInfo>[0], res: Parameters<typeof getActorInfo>[0] extends { params: any } ? any : any, entityType: string, entityId: string) {
    const typeParsed = entityTypeSchema.safeParse(entityType);
    if (!typeParsed.success) {
      res.status(400).json({ error: "Unsupported entity type", allowed: ALLOWED_ENTITY_TYPES });
      return null;
    }

    let companyId: string | null = await resolveEntityCompanyId(db, entityType, entityId);

    if (!companyId) {
      if (req.actor.type === "agent" && req.actor.companyId) {
        companyId = req.actor.companyId;
      } else if (req.actor.type === "board" && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length === 1) {
        companyId = req.actor.companyIds[0] as string;
      } else {
        res.status(404).json({ error: "Entity not found" });
        return null;
      }
    }

    return companyId;
  }

  router.get("/entities/:type/:id/documents", async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    assertCompanyAccess(req, companyId);
    const docs = await documentsSvc.listEntityDocuments(companyId, entityType, entityId);
    res.json(docs);
  });

  router.get("/entities/:type/:id/documents/:key", async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    assertCompanyAccess(req, companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getEntityDocumentByKey(companyId, entityType, entityId, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/entities/:type/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    await assertEntityWriteAccess(db, req, entityType, entityId, companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertEntityDocument({
      companyId,
      entityType,
      entityId,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "entity.document_created" : "entity.document_updated",
      entityType,
      entityId,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });
    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/entities/:type/:id/documents/:key/revisions", async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    assertCompanyAccess(req, companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listEntityDocumentRevisions(companyId, entityType, entityId, keyParsed.data);
    res.json(revisions);
  });

  // Convenience aliases: /profile → /documents/profile
  router.get("/entities/:type/:id/profile", async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    assertCompanyAccess(req, companyId);
    const doc = await documentsSvc.getEntityDocumentByKey(companyId, entityType, entityId, "profile");
    if (!doc) {
      res.status(404).json({ error: "Profile document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/entities/:type/:id/profile", validate(upsertIssueDocumentSchema), async (req, res) => {
    const entityType = req.params.type as string;
    const entityId = req.params.id as string;
    const companyId = await resolveEntity(req, res, entityType, entityId);
    if (!companyId) return;
    await assertEntityWriteAccess(db, req, entityType, entityId, companyId);
    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertEntityDocument({
      companyId,
      entityType,
      entityId,
      key: "profile",
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "entity.document_created" : "entity.document_updated",
      entityType,
      entityId,
      details: {
        key: "profile",
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });
    res.status(result.created ? 201 : 200).json(doc);
  });

  return router;
}
