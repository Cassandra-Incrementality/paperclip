// ---------------------------------------------------------------------------
// Shared provider-quota (usage-limit / rate-limit) classification.
//
// This is the ONE canonical reset-time parser for provider-quota exhaustion
// messages. Three copies of this logic predated this file (server-side
// recovery/service.ts, claude-local/parse.ts, codex-local/parse.ts) and had
// diverged on what to do when the provider gives no explicit timezone in its
// reset-time text -- some fell back to server-local time, some to UTC. That
// divergence is why ACPX (which had no copy at all) could not simply reuse
// one verbatim: this module standardises the no-timezone fallback on UTC.
// Do not add a fourth copy -- import from here.
// ---------------------------------------------------------------------------

const MONTH_INDEX_BY_ABBR: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Deliberately generic (adapter-agnostic): "usage/session/weekly/daily/monthly
// limit" plus the handful of provider-neutral phrasings already in use. Each
// adapter may additionally recognize its own CLI-specific wording (e.g.
// claude-local's "extra usage") -- that stays local to the adapter and is not
// folded in here.
export const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your (?:usage|session|weekly|daily|monthly) limit|(?:usage|session|weekly|daily|monthly) limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;

const RESET_TIME_RE =
  /(?:try again at|resets?)\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i;

export function isProviderQuotaErrorText(text: string): boolean {
  return PROVIDER_QUOTA_ERROR_RE.test(text);
}

function resolveWallClockInTimeZone(input: {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const targetMs = Date.UTC(input.year, input.month, input.day, input.hour, input.minute);
  const wallClockParts = (date: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  // DST-correct fixed-point resolution: the offset between "wall clock in
  // timeZone" and "UTC" can change between our guess and the target instant
  // (e.g. crossing a DST boundary), so iterate a few times to converge.
  let candidate = new Date(targetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = wallClockParts(candidate);
    const actualMs = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
    );
    const adjustment = targetMs - actualMs;
    if (adjustment === 0) break;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}

function timeZoneWallClockDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(byType.year), month: Number(byType.month) - 1, day: Number(byType.day) };
}

/**
 * Parses provider-quota reset phrasing out of raw adapter error text, e.g.
 * "try again at 4:30 PM (America/Chicago)" or "resets Jul 30 at 12pm
 * (Europe/Rome)". Returns null when no reset time can be extracted -- callers
 * should fall back to a fixed backoff in that case.
 *
 * When no timezone is present the reset clock is treated as UTC (see module
 * comment for why this is standardised rather than server-local).
 */
export function parseProviderQuotaResetTime(text: string, now: Date): Date | null {
  const match = text.match(RESET_TIME_RE);
  if (!match) return null;

  const monthAbbr = (match[1] ?? "").slice(0, 3).toLowerCase();
  const explicitDay = match[2] ? Number.parseInt(match[2], 10) : null;
  const explicitMonth = monthAbbr ? MONTH_INDEX_BY_ABBR[monthAbbr] : undefined;
  const hourValue = Number.parseInt(match[3] ?? "", 10);
  const minute = Number.parseInt(match[4] ?? "0", 10);
  const meridiem = (match[5] ?? "").toLowerCase();
  const timeZone = (match[6] ?? match[7])?.trim();

  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (explicitDay != null && (explicitMonth == null || explicitDay < 1 || explicitDay > 31)) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;

  const hasExplicitDate = explicitDay != null && explicitMonth != null;

  if (!timeZone) {
    if (hasExplicitDate) {
      const retryAt = new Date(Date.UTC(now.getUTCFullYear(), explicitMonth, explicitDay, hour, minute));
      if (retryAt.getTime() <= now.getTime()) retryAt.setUTCFullYear(retryAt.getUTCFullYear() + 1);
      return retryAt;
    }
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    if (hasExplicitDate) {
      const thisYear = resolveWallClockInTimeZone({
        year: now.getUTCFullYear(),
        month: explicitMonth,
        day: explicitDay,
        hour,
        minute,
        timeZone,
      });
      if (thisYear.getTime() > now.getTime()) return thisYear;
      return resolveWallClockInTimeZone({
        year: now.getUTCFullYear() + 1,
        month: explicitMonth,
        day: explicitDay,
        hour,
        minute,
        timeZone,
      });
    }
    const nowParts = timeZoneWallClockDate(now, timeZone);
    const sameDay = resolveWallClockInTimeZone({ ...nowParts, hour, minute, timeZone });
    if (sameDay.getTime() > now.getTime()) return sameDay;
    const nextDayUtc = new Date(Date.UTC(nowParts.year, nowParts.month, nowParts.day + 1));
    return resolveWallClockInTimeZone({
      year: nextDayUtc.getUTCFullYear(),
      month: nextDayUtc.getUTCMonth(),
      day: nextDayUtc.getUTCDate(),
      hour,
      minute,
      timeZone,
    });
  } catch {
    return null;
  }
}
