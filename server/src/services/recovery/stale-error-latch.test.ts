import { describe, expect, it } from "vitest";
import {
  findStaleErrorLatches,
  findStaleErrorReasonResidue,
  isHostAuthSessionErrorReason,
  type StaleErrorLatchAgentInput,
} from "./stale-error-latch.js";

const NOW = new Date("2026-08-28T03:00:00.000Z");

function agent(overrides: Partial<StaleErrorLatchAgentInput> & { id: string }): StaleErrorLatchAgentInput {
  return {
    companyId: "company-1",
    status: "idle",
    errorReason: null,
    lastHeartbeatAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("isHostAuthSessionErrorReason", () => {
  it("matches the exact PPC-4059/PPC-4081 wording", () => {
    expect(
      isHostAuthSessionErrorReason(
        "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
  });

  it("matches generic session/token expiry phrasing", () => {
    expect(isHostAuthSessionErrorReason("session expired, please re-login")).toBe(true);
    expect(isHostAuthSessionErrorReason("auth token expired")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isHostAuthSessionErrorReason("adapter execution timeout (timeoutSec=1000)")).toBe(false);
    expect(isHostAuthSessionErrorReason("process exited with code 1")).toBe(false);
    expect(isHostAuthSessionErrorReason(null)).toBe(false);
  });
});

describe("findStaleErrorLatches", () => {
  it("flags an errored agent whose OAuth error predates a sibling's later heartbeat", () => {
    const agents = [
      agent({
        id: "victim",
        status: "error",
        errorReason: "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-26T22:51:00.000Z"),
        lastHeartbeatAt: new Date("2026-08-26T22:50:00.000Z"),
      }),
      agent({
        id: "proof",
        status: "idle",
        lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
      }),
    ];

    const findings = findStaleErrorLatches(agents, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agentId: "victim",
      provenByAgentId: "proof",
    });
  });

  it("does not flag a genuine, unrelated error even if a sibling heartbeats later (PPC-4085 guard)", () => {
    const agents = [
      agent({
        id: "vp-product",
        status: "error",
        errorReason: "adapter execution timeout (timeoutSec=1000)",
        updatedAt: new Date("2026-08-27T18:00:00.000Z"),
      }),
      agent({
        id: "devops",
        status: "idle",
        lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
      }),
    ];

    expect(findStaleErrorLatches(agents, NOW)).toHaveLength(0);
  });

  it("does not flag when no sibling has heartbeated since the error", () => {
    const agents = [
      agent({
        id: "victim",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-28T02:00:00.000Z"),
      }),
      agent({
        id: "other",
        status: "idle",
        lastHeartbeatAt: new Date("2026-08-27T12:00:00.000Z"),
      }),
    ];

    expect(findStaleErrorLatches(agents, NOW)).toHaveLength(0);
  });

  it("ignores proof from a different company", () => {
    const agents = [
      agent({
        id: "victim",
        companyId: "company-1",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-26T22:51:00.000Z"),
      }),
      agent({
        id: "other-tenant",
        companyId: "company-2",
        status: "idle",
        lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z"),
      }),
    ];

    expect(findStaleErrorLatches(agents, NOW)).toHaveLength(0);
  });

  it("does not treat the candidate's own stale heartbeat as proof", () => {
    const agents = [
      agent({
        id: "victim",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-26T22:51:00.000Z"),
        lastHeartbeatAt: new Date("2026-08-28T05:00:00.000Z"), // later than now would be nonsensical to self-prove
      }),
    ];

    expect(findStaleErrorLatches(agents, NOW)).toHaveLength(0);
  });

  it("picks the latest proof among multiple later heartbeats", () => {
    const agents = [
      agent({
        id: "victim",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-26T22:51:00.000Z"),
      }),
      agent({ id: "earlier-proof", lastHeartbeatAt: new Date("2026-08-27T00:00:00.000Z") }),
      agent({ id: "later-proof", lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z") }),
    ];

    const findings = findStaleErrorLatches(agents, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].provenByAgentId).toBe("later-proof");
  });

  it("handles multiple independent stale candidates in one sweep", () => {
    const agents = [
      agent({
        id: "victim-a",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
        updatedAt: new Date("2026-08-26T22:00:00.000Z"),
      }),
      agent({
        id: "victim-b",
        status: "error",
        errorReason: "Failed to authenticate: OAuth session expired",
        updatedAt: new Date("2026-08-26T23:00:00.000Z"),
      }),
      agent({ id: "proof", lastHeartbeatAt: new Date("2026-08-28T02:03:00.000Z") }),
    ];

    const findings = findStaleErrorLatches(agents, NOW);
    expect(findings.map((f) => f.agentId).sort()).toEqual(["victim-a", "victim-b"]);
  });
});

describe("findStaleErrorReasonResidue", () => {
  it("flags a non-errored agent still carrying a host-auth errorReason (PPC-5088 shape)", () => {
    const agents = [
      agent({
        id: "video-producer",
        status: "idle",
        errorReason: "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
    ];

    const findings = findStaleErrorReasonResidue(agents);
    expect(findings).toEqual([{ agentId: "video-producer", companyId: "company-1" }]);
  });

  it("does not flag an agent that is still genuinely errored", () => {
    const agents = [
      agent({
        id: "still-latched",
        status: "error",
        errorReason: "OAuth session expired and could not be refreshed",
      }),
    ];

    expect(findStaleErrorReasonResidue(agents)).toHaveLength(0);
  });

  it("does not flag a non-errored agent with no errorReason", () => {
    const agents = [agent({ id: "clean", status: "idle", errorReason: null })];

    expect(findStaleErrorReasonResidue(agents)).toHaveLength(0);
  });

  it("does not flag a non-errored agent whose leftover errorReason is an unrelated failure", () => {
    const agents = [
      agent({
        id: "unrelated",
        status: "idle",
        errorReason: "adapter execution timeout (timeoutSec=1000)",
      }),
    ];

    expect(findStaleErrorReasonResidue(agents)).toHaveLength(0);
  });

  it("flags a 'running' agent with residue too, not just 'idle'", () => {
    const agents = [
      agent({
        id: "mid-run",
        status: "running",
        errorReason: "token expired, please re-login",
      }),
    ];

    expect(findStaleErrorReasonResidue(agents)).toEqual([{ agentId: "mid-run", companyId: "company-1" }]);
  });
});
