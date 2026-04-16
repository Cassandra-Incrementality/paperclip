# Diarization Convention

When an agent needs durable knowledge about an entity — a client, a competitor, a long-running project, another agent — it should read or write a **profile document** via the [`paperclip-diarize`](../../skills/paperclip-diarize/SKILL.md) skill, not re-derive context from raw threads on every heartbeat.

This page defines **when** to diarize, **when not to**, and **how** to keep profiles fresh without thrashing.

## 1. What is diarization?

Diarization is the act of distilling N noisy sources (issue threads, files, URLs, prior comments) into a compact, structured profile stored against a typed entity, via:

```
PUT /api/entities/:type/:id/profile
GET /api/entities/:type/:id/profile
```

Every profile uses the same five-section markdown schema, enforced by the `paperclip-diarize` skill:

1. **Identity** — what/who the entity is, canonical references, external IDs.
2. **Goals** — current objectives, success criteria, north-star metrics.
3. **Constraints** — rules, budgets, non-goals, policy/legal boundaries.
4. **History** — material events, decisions, pivots (chronological).
5. **Open Threads** — unresolved questions, pending approvals, who-owes-whom.

The skill also stamps a footer with the source list, timestamp, and author agent id.

## 2. When to diarize (the rule)

> Diarize an entity if **≥3 agents** or **≥3 heartbeats across different weeks** will reference it.

If only one agent will ever read the context, and only in the current task, do not create a profile — keep that context in the issue thread where it already lives.

### Yes — diarize these

| Entity type | Why it qualifies |
|---|---|
| **Client** | Multiple agents (CS, CMO, CTO, Finance) reference the same client across months. |
| **Competitor** | Ads, SEO, product, and GTM agents all pull the same competitor facts. |
| **Agent self-profile** | The agent re-reads its own identity every heartbeat; other agents reference it during delegation. |
| **Long-running project** | A multi-month initiative with stable goals, recurring stakeholders. |
| **Methodology playbook** | A reusable technique (e.g. MMM calibration) invoked by many tasks. |

### No — do not diarize these

| Entity type | Why it fails the bar |
|---|---|
| **Bug tickets** | One-off, closes in days. The issue thread is the canonical record. |
| **One-off PRs** | Lifetime < 1 week, referenced by 1–2 agents. |
| **Ephemeral experiments** | A spike, a prototype, a throwaway script. |
| **Tempfiles / scratch data** | Not an entity. Not durable. |

**The test**: if in three weeks a different agent would benefit from reading the distilled summary instead of re-reading the thread, diarize. Otherwise, don't.

## 3. Refresh cadence

Profiles decay. But re-running the skill on every heartbeat is wasteful and causes revision churn.

Refresh a profile **only on a material event**:

- status change on the entity (e.g. client moved from trial → paying, project moved from planning → executing);
- milestone crossed (launch, phase complete, contract signed);
- **≥5 new comments** or **≥3 new material events** since last refresh;
- explicit `--refresh` request from an owner agent.

Passive heartbeats — "I looked at this entity but nothing changed" — do not trigger a refresh.

If a profile has not been touched in **>30 days**, the owner agent should audit it on its next heartbeat even absent a material event. Drift beyond 30 days is a smell.

## 4. Ownership

Profile writer = the **owner's primary agent**. One agent owns the write path per entity, to avoid merge conflicts and divergent tone.

| Entity | Owning agent |
|---|---|
| Client | CS Ops |
| Competitor | CMO |
| Agent self-profile | The agent itself |
| Long-running project | Project lead agent |
| Methodology playbook | Methodology owner (often CTO or a research lead) |

Non-owner agents **read** the profile freely; if they discover a material fact the profile is missing, they should comment on the profile entity's backing issue — not silently write a parallel profile.

## 5. Versioning

Every `PUT /api/entities/:type/:id/profile` creates a new revision. Agents track which revision they have consumed via `baseRevisionId`:

- On read: capture `revisionId` into local task context.
- On next heartbeat referencing the same entity: compare latest `revisionId` against `baseRevisionId` — if unchanged, skip re-reading the full body.
- On write: send the `baseRevisionId` of the version you diffed against, so the server can detect conflicting concurrent writes.

The skill's `--refresh` flow is:

1. `GET` current profile → note `revisionId`.
2. Re-diarize sources.
3. `PUT` only if content changed; pass `baseRevisionId` = previous `revisionId`.

No content change = no new revision. This prevents churn in revision history and downstream cache invalidation.

## 6. Anti-patterns

- **Copy-pasting raw source into the profile.** A profile is a distillation, not an archive. If you can't compress a thread into the 5-section schema, the thread probably isn't diarize-worthy.
- **Letting profiles drift >30 days without review.** A stale profile is worse than no profile — downstream agents act on wrong facts with false confidence.
- **Writing profiles for ephemeral entities.** If the entity will not exist (or will not matter) in a month, the profile is waste and will be wrong before it is re-read.
- **Multiple agents writing the same profile.** Ownership is singular. Non-owners comment on the backing issue and let the owner re-diarize.
- **Diarizing at the wrong granularity.** Prefer one profile per stable entity over many profiles per sub-topic. `client:acme` beats `client:acme-q2-renewal` and `client:acme-support-escalations`.
- **Skipping the `baseRevisionId` check.** Causes silent overwrites when two heartbeats race.

## 7. Related

- Skill: [`paperclip-diarize`](../../skills/paperclip-diarize/SKILL.md) — read N sources, write a structured profile.
- API: `GET`/`PUT /api/entities/:type/:id/profile` — entity profile documents with revisions.
- Contributor rules: [`AGENTS.md`](../../AGENTS.md).
