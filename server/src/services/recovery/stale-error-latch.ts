// Cross-agent staleness proof for agents parked in status = 'error' after a
// host-level auth/session blip (PPC-4088, 3rd recurrence of PPC-3948/PPC-4059).
//
// `reconcileErroredAgents` (PPC-3291) only auto-clears errorFamily in
// {provider_quota, transient_upstream} - OAuth/session-expiry failures are
// unclassified free text from the underlying CLI and fall through untouched,
// so once one lands, status = 'error' is a permanent latch: nothing else
// writes agents.status, and the recurring "Agent liveness check" routine
// treats status == 'error' as an unambiguous, un-decaying signal, so it just
// re-pages the same latch every cycle until a human manually PATCHes it.
//
// This module supplies a much stronger and safer signal than blind
// retry-with-backoff: if a DIFFERENT agent's lastHeartbeatAt is newer than
// the candidate's own error timestamp, the platform/dispatcher/host auth
// were provably working again after the candidate entered error - the
// candidate's error is stale, not live, regardless of whether the specific
// CLI-level blip that caused it has "resolved" in any way we can observe
// directly. Deliberately narrow: only fires for errorReason text that
// matches known host auth/session phrasing, so it can never auto-clear an
// unrelated genuine failure (e.g. an adapter execution timeout) just because
// some other agent happened to heartbeat later - see PPC-4085 for why that
// distinction matters.
//
// Pure and DB-free by design (mirrors run-liveness-continuations.ts /
// issue-graph-liveness.ts) so the staleness rule itself is unit-testable
// without a database; the DB-touching sweep wrapper lives in heartbeat.ts.

const HOST_AUTH_SESSION_ERROR_PATTERN =
  /\b(oauth|o-auth)\b.{0,40}\b(session|token)\b.{0,40}\bexpired\b|\bsession\b.{0,20}\bexpired\b|\btoken\b.{0,20}\bexpired\b|\bfailed to authenticate\b|\bcould not be refreshed\b|\bre-?authenticate\b|\bplease\s+(re-?)?login\b/i;

export interface StaleErrorLatchAgentInput {
  id: string;
  companyId: string;
  status: string;
  errorReason: string | null;
  lastHeartbeatAt: Date | string | null;
  /** Time the agent entered its current status; agents has no dedicated
   * "erroredAt" column, so callers pass `updatedAt` - finalizeAgentStatus is
   * the only writer of status = 'error' and always bumps updatedAt with it,
   * so while status stays 'error' this value is exactly the error's age. */
  updatedAt: Date | string;
}

export interface StaleErrorLatchFinding {
  agentId: string;
  companyId: string;
  erroredAt: Date;
  provenByAgentId: string;
  provenByHeartbeatAt: Date;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isHostAuthSessionErrorReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return HOST_AUTH_SESSION_ERROR_PATTERN.test(reason);
}

/**
 * Finds agents whose status = 'error' is provably stale: some OTHER agent in
 * the same company heartbeated successfully strictly after the candidate's
 * error timestamp. Scoped to companyId because the proof only holds for
 * agents that actually share the host/credential the incident is about -
 * a heartbeat from an unrelated company's deployment proves nothing.
 */
export function findStaleErrorLatches(
  agentsList: StaleErrorLatchAgentInput[],
  now: Date = new Date(),
): StaleErrorLatchFinding[] {
  const findings: StaleErrorLatchFinding[] = [];

  for (const candidate of agentsList) {
    if (candidate.status !== "error") continue;
    if (!isHostAuthSessionErrorReason(candidate.errorReason)) continue;

    const erroredAt = toDate(candidate.updatedAt);
    if (!erroredAt || erroredAt.getTime() > now.getTime()) continue;

    let proof: { id: string; at: Date } | null = null;
    for (const other of agentsList) {
      if (other.id === candidate.id || other.companyId !== candidate.companyId) continue;
      const heartbeatAt = toDate(other.lastHeartbeatAt);
      if (!heartbeatAt || heartbeatAt.getTime() <= erroredAt.getTime()) continue;
      if (!proof || heartbeatAt.getTime() > proof.at.getTime()) {
        proof = { id: other.id, at: heartbeatAt };
      }
    }

    if (proof) {
      findings.push({
        agentId: candidate.id,
        companyId: candidate.companyId,
        erroredAt,
        provenByAgentId: proof.id,
        provenByHeartbeatAt: proof.at,
      });
    }
  }

  return findings;
}

export interface StaleErrorReasonResidueFinding {
  agentId: string;
  companyId: string;
}

/**
 * Finds agents carrying a leftover host-auth/session errorReason string
 * even though status is no longer 'error' (PPC-5088). This is a DIFFERENT
 * defect shape from findStaleErrorLatches above: that function clears the
 * *latch* (status='error') via the CAS update in the DB-touching wrapper,
 * which only fires while status is still 'error'. If something else flips
 * status back to 'idle'/'running'/etc WITHOUT going through that path - a
 * status-only PATCH is the observed cause on PPC-5088, `agent.updated`
 * activity_log row with changedTopLevelKeys:["status"] only - errorReason
 * is left behind forever, because it is server-owned and not part of
 * updateAgentSchema, so no ordinary write can clear it once status has
 * already moved on. The column is inert for dispatch once status != 'error'
 * (nothing reads it), but it is exactly the bait a liveness/health check
 * keying on errorReason text - instead of the live status field, the thing
 * the [agent-health] routine's own rules say to key on - will misdiagnose
 * as a live latch, which is how PPC-5088 itself got filed against an agent
 * that had already been idle for 18 days.
 */
export function findStaleErrorReasonResidue(
  agentsList: StaleErrorLatchAgentInput[],
): StaleErrorReasonResidueFinding[] {
  return agentsList
    .filter((candidate) => candidate.status !== "error" && isHostAuthSessionErrorReason(candidate.errorReason))
    .map((candidate) => ({ agentId: candidate.id, companyId: candidate.companyId }));
}
