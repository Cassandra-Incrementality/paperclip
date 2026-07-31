import { describe, expect, it } from "vitest";
import {
  formatSameAgentThreadConflictReconcileInstruction,
  isSameAgentThreadConflictDetails,
} from "./same-agent-thread-conflict.js";

const VALID_DETAILS = {
  issueId: "issue-1",
  conflictingRunId: "run-1",
  conflictingCommentId: "comment-1",
  conflictingCommentBody: "Ruling: three-entry spec.",
  conflictingCreatedAt: "2026-07-31T12:00:00.000Z",
  guidance:
    "Another live run of yours already wrote to this thread. Re-read it, reconcile both positions, and post ONE merged comment.",
};

describe("isSameAgentThreadConflictDetails", () => {
  it("recognizes the guard's 409 details shape", () => {
    expect(isSameAgentThreadConflictDetails(VALID_DETAILS)).toBe(true);
  });

  it("rejects other 409 shapes (e.g. checkout conflict) that don't carry the guard's fields", () => {
    expect(
      isSameAgentThreadConflictDetails({
        checkoutRunId: "run-1",
        agentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("rejects a generic 409 with no details", () => {
    expect(isSameAgentThreadConflictDetails(undefined)).toBe(false);
    expect(isSameAgentThreadConflictDetails(null)).toBe(false);
  });

  it("rejects details missing any one required field", () => {
    const { guidance, ...withoutGuidance } = VALID_DETAILS;
    expect(isSameAgentThreadConflictDetails(withoutGuidance)).toBe(false);
  });
});

describe("formatSameAgentThreadConflictReconcileInstruction", () => {
  it("surfaces the conflicting comment body and a merge-then-repost instruction, not a bare 409", () => {
    const message = formatSameAgentThreadConflictReconcileInstruction(VALID_DETAILS);
    expect(message).toContain("RECONCILE REQUIRED");
    expect(message).toContain(VALID_DETAILS.conflictingCommentBody);
    expect(message).toContain(VALID_DETAILS.conflictingRunId);
    expect(message).toContain(VALID_DETAILS.guidance);
    expect(message.toLowerCase()).toContain("do not retry");
    expect(message.toLowerCase()).toContain("post one");
  });
});
