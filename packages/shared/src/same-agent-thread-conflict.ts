// PPC-3302: recognizes and formats the 409 shape thrown by
// findLiveSameAgentThreadConflict (server/src/services/issues.ts, PPC-3187).
// That guard rejects a comment when a live sibling run of the same agent
// already wrote to the thread — it is a reconcile instruction, not a hard
// write failure. Every agent-facing write path (MCP tool responses, CLI
// stderr) should route the conflict through here so the conflicting
// comment's content survives instead of being lost in a generic 409 (PPC-3160).
export interface SameAgentThreadConflictDetails {
  issueId?: string;
  conflictingRunId: string;
  conflictingCommentId: string;
  conflictingCommentBody: string;
  conflictingCreatedAt?: string;
  guidance: string;
}

export function isSameAgentThreadConflictDetails(
  details: unknown,
): details is SameAgentThreadConflictDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as Record<string, unknown>;
  return (
    typeof candidate.conflictingRunId === "string" &&
    typeof candidate.conflictingCommentId === "string" &&
    typeof candidate.conflictingCommentBody === "string" &&
    typeof candidate.guidance === "string"
  );
}

export function formatSameAgentThreadConflictReconcileInstruction(
  details: SameAgentThreadConflictDetails,
): string {
  return [
    "RECONCILE REQUIRED — not a failed write. A live sibling run of you already commented on this thread; this comment was rejected so the two positions don't silently overwrite each other.",
    "",
    `Conflicting comment (run ${details.conflictingRunId}, comment ${details.conflictingCommentId}):`,
    "---",
    details.conflictingCommentBody,
    "---",
    "",
    details.guidance,
    "",
    "Do not retry this exact comment as-is — a blind retry will 409 again while that sibling run stays live. Re-read the thread, reconcile both positions, and post ONE new merged comment.",
  ].join("\n");
}
