import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const docId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const mockDocumentService = vi.hoisted(() => ({
  listEntityDocuments: vi.fn(),
  getEntityDocumentByKey: vi.fn(),
  upsertEntityDocument: vi.fn(),
  listEntityDocumentRevisions: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/documents.js", () => ({
  ALLOWED_ENTITY_TYPES: ["agent", "project", "goal", "client", "competitor", "playbook"],
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    projectService: () => mockProjectService,
    goalService: () => mockGoalService,
    documentService: () => mockDocumentService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/documents.js", () => ({
    ALLOWED_ENTITY_TYPES: ["agent", "project", "goal", "client", "competitor", "playbook"],
  }));
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: docId,
    companyId,
    entityType: "agent",
    entityId: agentId,
    key: "profile",
    title: "Profile",
    format: "markdown",
    latestBody: "# Agent Profile",
    latestRevisionId: revisionId,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    body: "# Agent Profile",
    ...overrides,
  };
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ entityRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/entities.js")>("../routes/entities.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", entityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("entity document routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/entities.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockAgentService.getById.mockResolvedValue({ id: agentId, companyId });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /entities/:type/:id/documents/:key", () => {
    it("returns a document when it exists", async () => {
      const doc = makeDoc();
      mockDocumentService.getEntityDocumentByKey.mockResolvedValue(doc);

      const res = await request(await createApp())
        .get(`/api/entities/agent/${agentId}/documents/profile`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: "profile", entityType: "agent", entityId: agentId });
      expect(mockDocumentService.getEntityDocumentByKey).toHaveBeenCalledWith(
        companyId, "agent", agentId, "profile",
      );
    });

    it("returns 404 when document does not exist", async () => {
      mockDocumentService.getEntityDocumentByKey.mockResolvedValue(null);

      const res = await request(await createApp())
        .get(`/api/entities/agent/${agentId}/documents/profile`);

      expect(res.status).toBe(404);
    });

    it("returns 400 for unsupported entity type", async () => {
      const res = await request(await createApp())
        .get(`/api/entities/spaceship/${agentId}/documents/profile`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Unsupported entity type");
    });
  });

  describe("PUT /entities/:type/:id/documents/:key — create", () => {
    it("creates a new document and returns 201", async () => {
      const doc = makeDoc({ latestRevisionNumber: 1 });
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: true });

      const res = await request(await createApp())
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# Agent Profile", baseRevisionId: null });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ key: "profile", entityType: "agent" });
      expect(mockDocumentService.upsertEntityDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId,
          entityType: "agent",
          entityId: agentId,
          key: "profile",
          format: "markdown",
          body: "# Agent Profile",
          baseRevisionId: null,
        }),
      );
    });

    it("updates an existing document and returns 200", async () => {
      const doc = makeDoc({ latestRevisionNumber: 2 });
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: false });

      const res = await request(await createApp())
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# Updated Profile", baseRevisionId: revisionId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ latestRevisionNumber: 2 });
    });

    it("propagates conflict error when baseRevisionId is stale", async () => {
      const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockDocumentService.upsertEntityDocument.mockRejectedValue(
        conflict("Document was updated by someone else"),
      );

      const staleRevId = "11111111-1111-4111-8111-000000000099";
      const res = await request(await createApp())
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "conflicting edit", baseRevisionId: staleRevId });

      expect(res.status).toBe(409);
    });

    it("logs activity after create", async () => {
      const doc = makeDoc();
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: true });

      await request(await createApp())
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# Agent Profile", baseRevisionId: null });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "entity.document_created",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });
  });

  describe("GET /entities/:type/:id/profile — convenience alias", () => {
    it("returns profile document via alias", async () => {
      const doc = makeDoc();
      mockDocumentService.getEntityDocumentByKey.mockResolvedValue(doc);

      const res = await request(await createApp())
        .get(`/api/entities/agent/${agentId}/profile`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: "profile" });
      expect(mockDocumentService.getEntityDocumentByKey).toHaveBeenCalledWith(
        companyId, "agent", agentId, "profile",
      );
    });

    it("returns 404 when profile does not exist", async () => {
      mockDocumentService.getEntityDocumentByKey.mockResolvedValue(null);

      const res = await request(await createApp())
        .get(`/api/entities/agent/${agentId}/profile`);

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /entities/:type/:id/profile — convenience alias", () => {
    it("upserts profile and returns 201 on create", async () => {
      const doc = makeDoc();
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: true });

      const res = await request(await createApp())
        .put(`/api/entities/agent/${agentId}/profile`)
        .send({ format: "markdown", body: "# Profile", baseRevisionId: null });

      expect(res.status).toBe(201);
      expect(mockDocumentService.upsertEntityDocument).toHaveBeenCalledWith(
        expect.objectContaining({ key: "profile" }),
      );
    });
  });

  describe("GET /entities/:type/:id/documents/:key/revisions", () => {
    it("returns revision history", async () => {
      const revisions = [
        { id: revisionId, revisionNumber: 1, body: "# v1", createdAt: new Date() },
      ];
      mockDocumentService.listEntityDocumentRevisions.mockResolvedValue(revisions);

      const res = await request(await createApp())
        .get(`/api/entities/agent/${agentId}/documents/profile/revisions`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ revisionNumber: 1 });
    });
  });

  describe("auth — agent write access", () => {
    it("allows agent to write its own profile", async () => {
      const doc = makeDoc();
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: false });

      const res = await request(
        await createApp({
          type: "agent",
          agentId,
          companyId,
          source: "api_key",
        }),
      )
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# My own profile", baseRevisionId: null });

      expect(res.status).toBe(200);
    });

    it("allows ancestor manager to write subordinate agent profile", async () => {
      const managerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      mockAgentService.getChainOfCommand.mockResolvedValue([
        { id: managerId },
        { id: agentId },
      ]);
      const doc = makeDoc();
      mockDocumentService.upsertEntityDocument.mockResolvedValue({ document: doc, created: false });

      const res = await request(
        await createApp({
          type: "agent",
          agentId: managerId,
          companyId,
          source: "api_key",
        }),
      )
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# Managed profile", baseRevisionId: null });

      expect(res.status).toBe(200);
    });

    it("blocks unrelated agent from writing another agent's profile", async () => {
      const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      mockAgentService.getChainOfCommand.mockResolvedValue([{ id: agentId }]);

      const res = await request(
        await createApp({
          type: "agent",
          agentId: otherId,
          companyId,
          source: "api_key",
        }),
      )
        .put(`/api/entities/agent/${agentId}/documents/profile`)
        .send({ format: "markdown", body: "# Unauthorized", baseRevisionId: null });

      expect(res.status).toBe(403);
    });
  });

  describe("read by entity type", () => {
    it.each([["project", "pppppppp-pppp-4ppp-8ppp-pppppppppppp"], ["goal", "gggggggg-gggg-4ggg-8ggg-gggggggggggg"]] as const)(
      "reads %s documents",
      async (entityType, entityId) => {
        if (entityType === "project") {
          mockProjectService.getById = vi.fn().mockResolvedValue({ id: entityId, companyId });
        } else {
          mockGoalService.getById = vi.fn().mockResolvedValue({ id: entityId, companyId });
        }
        const doc = makeDoc({ entityType, entityId });
        mockDocumentService.getEntityDocumentByKey.mockResolvedValue(doc);

        const res = await request(await createApp())
          .get(`/api/entities/${entityType}/${entityId}/documents/notes`);

        expect(res.status).toBe(200);
        expect(mockDocumentService.getEntityDocumentByKey).toHaveBeenCalled();
      },
    );

    it.each([["client", "client-id-1"], ["competitor", "comp-id-1"], ["playbook", "play-id-1"]] as const)(
      "reads %s documents (no dedicated table — falls through to actor context)",
      async (entityType, entityId) => {
        mockAgentService.getById.mockResolvedValue(null);
        mockProjectService.getById = vi.fn().mockResolvedValue(null);
        mockGoalService.getById = vi.fn().mockResolvedValue(null);
        const doc = makeDoc({ entityType, entityId });
        mockDocumentService.getEntityDocumentByKey.mockResolvedValue(doc);

        const res = await request(await createApp())
          .get(`/api/entities/${entityType}/${entityId}/documents/notes`);

        expect(res.status).toBe(200);
      },
    );
  });
});
