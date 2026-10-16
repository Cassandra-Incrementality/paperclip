import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  unblockDescriptorsEqual,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });
});

describe("unblockDescriptorsEqual", () => {
  it("treats null and undefined descriptors as equal to each other", () => {
    expect(unblockDescriptorsEqual(null, undefined)).toBe(true);
    expect(unblockDescriptorsEqual(undefined, undefined)).toBe(true);
    expect(unblockDescriptorsEqual(null, { owner: "board", action: "x" })).toBe(false);
    expect(unblockDescriptorsEqual({ owner: "board", action: "x" }, null)).toBe(false);
  });

  it("is sensitive to the action text", () => {
    const owner = { agentId };
    expect(unblockDescriptorsEqual({ owner, action: "Fix it" }, { owner, action: "Fix it" })).toBe(true);
    expect(unblockDescriptorsEqual({ owner, action: "Fix it" }, { owner, action: "Fix it now" })).toBe(false);
  });

  it("treats board descriptors as equal only to other board descriptors", () => {
    expect(unblockDescriptorsEqual(
      { owner: "board", action: "Inspect the run evidence" },
      { owner: "board", action: "Inspect the run evidence" },
    )).toBe(true);
    expect(unblockDescriptorsEqual(
      { owner: "board", action: "Inspect the run evidence" },
      { owner: { agentId }, action: "Inspect the run evidence" },
    )).toBe(false);
  });

  it("distinguishes agent owners by id, not just by owner shape", () => {
    expect(unblockDescriptorsEqual(
      { owner: { agentId }, action: "Fix it" },
      { owner: { agentId: "00000000-0000-4000-8000-000000000099" }, action: "Fix it" },
    )).toBe(false);
    expect(unblockDescriptorsEqual(
      { owner: { agentId }, action: "Fix it" },
      { owner: { userId: agentId }, action: "Fix it" },
    )).toBe(false);
  });

  it("distinguishes user owners by id", () => {
    expect(unblockDescriptorsEqual(
      { owner: { userId: "user-1" }, action: "Review" },
      { owner: { userId: "user-1" }, action: "Review" },
    )).toBe(true);
    expect(unblockDescriptorsEqual(
      { owner: { userId: "user-1" }, action: "Review" },
      { owner: { userId: "user-2" }, action: "Review" },
    )).toBe(false);
  });
});
