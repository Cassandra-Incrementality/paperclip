import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker diagnostic route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "Diagnostics") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `DG${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    parentId?: string | null;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function blockIssue(db: Db, companyId: string, blockerIssueId: string, blockedIssueId: string) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

async function attachLowTrustRun(db: Db, fixture: {
  company: CompanyRow;
  agent: AgentRow;
  allowedProject: ProjectRow;
  root: IssueRow;
  visibleBlocker: IssueRow;
}) {
  const executionPolicy = {
    authorizationPolicy: {
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: fixture.company.id,
        projectIds: [fixture.allowedProject.id],
        rootIssueId: fixture.root.id,
        issueIds: [fixture.root.id, fixture.visibleBlocker.id],
        allowedAgentIds: [],
      },
    },
  };
  await db.update(agents).set({
    permissions: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: executionPolicy.authorizationPolicy,
    },
  }).where(eq(agents.id, fixture.agent.id));
  fixture.agent.permissions = {
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    authorizationPolicy: executionPolicy.authorizationPolicy,
  };

  const [run] = await db.insert(heartbeatRuns).values({
    companyId: fixture.company.id,
    agentId: fixture.agent.id,
    status: "running",
    contextSnapshot: {
      issueId: fixture.root.id,
      executionPolicy,
    },
  }).returning();
  await db.update(issues).set({
    assigneeAgentId: fixture.agent.id,
    checkoutRunId: run!.id,
    executionRunId: run!.id,
    executionPolicy,
  }).where(eq(issues.id, fixture.root.id));
  return run!;
}

describeEmbeddedPostgres("issue blocker diagnostics route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-diagnostics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns stale-blocker diagnosis and anomaly flags for a done blocker on a blocked issue", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Ship root",
      status: "blocked",
      assigneeAgentId: agent.id,
    });
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Finished blocker",
      status: "done",
    });
    await blockIssue(db, company.id, blocker.id, root.id);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("stale blocker hold"),
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerCount: 0,
        pendingFinalizeBlockerCount: 0,
      },
      omittedUnauthorizedBlockerCount: 0,
      truncated: false,
    });
    expect(res.body.blockers).toHaveLength(1);
    expect(res.body.blockers[0]).toMatchObject({
      id: blocker.id,
      status: "done",
      isDependencyReady: true,
      flags: ["done_but_blocking"],
    });
  });

  it("returns null diagnosis for an unblocked issue with no blocker relations", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Ready work",
      status: "todo",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.blockers).toEqual([]);
    expect(res.body.readiness).toMatchObject({
      allBlockersDone: true,
      isDependencyReady: true,
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerCount: 0,
    });
  });

  it("omits unauthorized blocker nodes and derives diagnosis only from visible data", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const allowedProject = await seedProject(db, company.id, "Allowed");
    const hiddenProject = await seedProject(db, company.id, "Hidden");
    const hiddenMarker = `HIDDEN-BLOCKER-${randomUUID()}`;
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Scoped root",
      status: "blocked",
    });
    const visibleBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Visible blocker",
      status: "in_progress",
    });
    const hiddenBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: hiddenProject.id,
      title: hiddenMarker,
      status: "cancelled",
    });
    await blockIssue(db, company.id, visibleBlocker.id, root.id);
    await blockIssue(db, company.id, hiddenBlocker.id, root.id);
    const run = await attachLowTrustRun(db, { company, agent, allowedProject, root, visibleBlocker });

    const res = await request(createApp(db, agentActor(company, agent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockers).toHaveLength(1);
    expect(res.body.blockers[0]).toMatchObject({
      id: visibleBlocker.id,
      status: "in_progress",
      isUnresolved: true,
    });
    expect(res.body.readiness).toBeNull();
    expect(res.body.omittedUnauthorizedBlockerCount).toBe(1);
    expect(res.body.diagnosis).toContain("authorization boundary");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(hiddenBlocker.id);
    expect(serialized).not.toContain(hiddenMarker);
    expect(serialized).not.toContain("cancelled");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("details");
    expect(serialized).not.toContain("triggerDetail");
    expect(serialized).not.toContain("error");
  });

  it("denies cross-company issue reads", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);
    const projectA = await seedProject(db, companyA.id, "A");
    const issueA = await seedIssue(db, {
      companyId: companyA.id,
      projectId: projectA.id,
      title: "Company A issue",
      status: "blocked",
    });
    const [runB] = await db.insert(heartbeatRuns).values({
      companyId: companyB.id,
      agentId: agentB.id,
      status: "running",
      contextSnapshot: { issueId: issueA.id },
    }).returning();

    const res = await request(createApp(db, agentActor(companyB, agentB, runB!.id)))
      .get(`/api/issues/${issueA.id}/diagnostics/blockers`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("caps blocker output and withholds readiness when truncated", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wide blocked issue",
      status: "blocked",
    });
    const blockerRows = [];
    for (let index = 0; index < 101; index += 1) {
      blockerRows.push({
        companyId: company.id,
        projectId: project.id,
        title: `Blocker ${String(index).padStart(3, "0")}`,
        status: "done",
        priority: "medium",
        responsibleUserId: "board-user",
      });
    }
    const insertedBlockers = await db.insert(issues).values(blockerRows).returning();
    await db.insert(issueRelations).values(insertedBlockers.map((blocker) => ({
      companyId: company.id,
      issueId: blocker.id,
      relatedIssueId: root.id,
      type: "blocks" as const,
    })));

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockers).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
    expect(res.body.readiness).toBeNull();
    expect(res.body.omittedUnauthorizedBlockerCount).toBeNull();
    expect(res.body.diagnosis).toContain("truncated at 100 blockers");
    expect(res.body.caps).toEqual({ maxBlockers: 100 });
  });

  // An empty blocker set is not evidence that nothing is holding the issue:
  // the `blocked` transition's own precondition accepts a pending thread
  // interaction, and a monitor wakes the issue on a timer. Both were invisible
  // here, so a correctly card-held park and a stranded one returned the same
  // diagnosis — the mechanism behind a sweep that reported four correctly
  // blocked issues as dead parks.
  it("reports a pending interaction as the hold on a blocked issue with no blocker relations", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Waiting on a decision card",
      status: "blocked",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Answer this to unblock" },
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockers).toEqual([]);
    expect(res.body.hold).toEqual({
      kind: "pending_interaction",
      hasWakePath: true,
      pendingInteractionCount: 1,
      // Seeded without a resolver policy, which is how cards are written in
      // practice: 7 of the 8 live card-held issues on the board read this way.
      pendingInteractionHumanOnlyCount: 0,
      pendingInteractionUnclassifiedCount: 1,
      monitorNextCheckAt: null,
      hasUnblockDescriptor: false,
    });
    expect(res.body.diagnosis).toContain("held by 1 pending thread interaction");
    expect(res.body.diagnosis).not.toContain("nothing will wake it");
  });

  // "A card holds this" and "only a human can answer that card" are different
  // facts, and they call for opposite actions: a capability-gated hold must be
  // left alone, while a hold waiting on a human for something the holder could
  // do itself never clears. `c4d536ab` sat 74 days self-labelled "board
  // decision, agents do not resolve" on an ask its own holder owned (PPC-7742).
  it("says who must answer is unverified when no resolver policy was ever set on the card", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Held by an unclassified card",
      status: "blocked",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Board decision, agents do not resolve" },
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toMatchObject({
      kind: "pending_interaction",
      hasWakePath: true,
      pendingInteractionCount: 1,
      pendingInteractionHumanOnlyCount: 0,
      pendingInteractionUnclassifiedCount: 1,
    });
    // The prose in the payload is the filer's self-label, not evidence.
    expect(res.body.diagnosis).toContain("who must answer is unverified");
    expect(res.body.diagnosis).toContain("held by 1 pending thread interaction");
  });

  it("does not call the addressee unverified when the card declares human_only explicitly", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Held by a classified card",
      status: "blocked",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Rotate the credential" },
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toMatchObject({
      kind: "pending_interaction",
      pendingInteractionCount: 1,
      pendingInteractionHumanOnlyCount: 1,
      pendingInteractionUnclassifiedCount: 0,
    });
    expect(res.body.diagnosis).not.toContain("who must answer is unverified");
    expect(res.body.diagnosis).toContain("held by 1 pending thread interaction");
  });

  // A platform-imposed policy is still an assertion, just not the requester's.
  // `effectiveResolverPolicySource` grows over time (`company_cap`,
  // `governed_action`, `reserved_repo_action`, …); each new source must keep
  // counting as classified, or the unverified wording fires on cards the
  // platform itself gated.
  it("counts a platform-imposed resolver policy as classified, not unverified", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Held by a governed card",
      status: "blocked",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Push to a protected branch" },
      // The requester never classified it; the platform did.
      requestedResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "governed_action",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toMatchObject({
      kind: "pending_interaction",
      pendingInteractionCount: 1,
      pendingInteractionHumanOnlyCount: 1,
      pendingInteractionUnclassifiedCount: 0,
    });
    expect(res.body.diagnosis).not.toContain("who must answer is unverified");
  });

  it("reports an armed monitor as the hold when there is no blocker relation or pending interaction", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const monitorNextCheckAt = new Date("2026-12-01T09:00:00.000Z");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Waiting on a timer",
      status: "blocked",
    });
    await db.update(issues).set({ monitorNextCheckAt }).where(eq(issues.id, issue.id));

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toEqual({
      kind: "monitor",
      hasWakePath: true,
      pendingInteractionCount: 0,
      pendingInteractionHumanOnlyCount: 0,
      pendingInteractionUnclassifiedCount: 0,
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      hasUnblockDescriptor: false,
    });
    expect(res.body.diagnosis).toContain("held by an armed monitor");
  });

  it("says plainly that nothing will wake a blocked issue with no blocker, interaction or monitor", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Stranded",
      status: "blocked",
    });
    // A resolved card is not a hold, and an unblock descriptor is not a wake
    // path — neither may rescue this issue from the `none` verdict.
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "resolved",
      payload: { title: "Already answered" },
    });
    await db.update(issues).set({
      unblockDescriptor: { owner: "board", action: "Someone please look at this" },
    }).where(eq(issues.id, issue.id));

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toEqual({
      kind: "none",
      hasWakePath: false,
      pendingInteractionCount: 0,
      // A resolved card is not counted, so it cannot make the hold look
      // classified either.
      pendingInteractionHumanOnlyCount: 0,
      pendingInteractionUnclassifiedCount: 0,
      monitorNextCheckAt: null,
      hasUnblockDescriptor: true,
    });
    expect(res.body.diagnosis).toContain("nothing will wake it");
  });

  it("reports the blocker relation as the hold when one is unresolved", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Upstream",
      status: "in_progress",
    });
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Downstream",
      status: "blocked",
    });
    await blockIssue(db, company.id, blocker.id, root.id);
    // A pending card alongside a live blocker edge must not outrank it.
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: root.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Also waiting on a card" },
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/blockers`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toMatchObject({
      kind: "blocker_relation",
      hasWakePath: true,
      pendingInteractionCount: 1,
    });
    expect(res.body.diagnosis).toContain("is blocked by");
  });

  it("reports hasWakePath true one hop deep, even when the blocker itself is stranded", async () => {
    // Pins the documented limitation rather than asserting desired behaviour.
    // `hasWakePath` is scoped to THIS issue: `kind` resolves to
    // `blocker_relation` on `unresolvedBlockerCount > 0` alone, so an issue
    // behind a blocker that is itself held by nothing still reports `true`.
    // That is intentional — resolving the chain would turn a per-issue read
    // into a graph walk per request — but it is a trap for a liveness sweep,
    // which is why it is tested and documented in `api-reference.md` instead of
    // left to be rediscovered. Measured on the Cassandra board 2026-11-18: 57
    // issues of this exact shape report `true` while nothing can ever wake
    // them, on top of the 252 that report `false` (PPC-7742).
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    // The leaf: blocked, no card, no monitor, no blocker of its own.
    const strandedBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Stranded upstream",
      status: "blocked",
    });
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Downstream of a dead end",
      status: "blocked",
    });
    await blockIssue(db, company.id, strandedBlocker.id, root.id);

    const app = createApp(db, boardActor(company));
    const leafRes = await request(app)
      .get(`/api/issues/${strandedBlocker.id}/diagnostics/blockers`);
    expect(leafRes.status, JSON.stringify(leafRes.body)).toBe(200);
    expect(leafRes.body.hold).toMatchObject({ kind: "none", hasWakePath: false });

    const res = await request(app).get(`/api/issues/${root.id}/diagnostics/blockers`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toMatchObject({
      kind: "blocker_relation",
      // One hop: true despite the chain terminating in `hasWakePath: false`.
      hasWakePath: true,
      pendingInteractionCount: 0,
    });
  });

  it("leaves the subtree endpoint's wording untouched, since it does not resolve non-relation wake paths", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Card-held parent",
      status: "blocked",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { title: "Answer this to unblock" },
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/subtree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const node = res.body.nodes.find(
      (candidate: { issue: { id: string } }) => candidate.issue.id === issue.id,
    );
    // The subtree node does not resolve interactions or monitors, so it makes
    // no hold claim at all and keeps the pre-existing wording. A caller that
    // cannot see the non-relation wake paths must never be handed a sentence
    // saying nothing will wake the issue — that is the defect being fixed.
    expect(node.hold).toBeUndefined();
    expect(node.diagnosis).toBe(
      `${node.issue.identifier ?? node.issue.title} is blocked but has no first-class blocker relations.`,
    );
  });
});
