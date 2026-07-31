import { describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_ERROR_RE, isProviderQuotaErrorText, parseProviderQuotaResetTime } from "./provider-quota.js";

describe("isProviderQuotaErrorText", () => {
  it("matches the verbatim 2026-07-29 ACPX weekly-limit message (PPC-3228)", () => {
    expect(
      isProviderQuotaErrorText(
        "Internal error: You've hit your weekly limit · resets Jul 30 at 12pm (Europe/Rome).",
      ),
    ).toBe(true);
  });

  it("matches usage-limit and generic quota phrasing", () => {
    expect(PROVIDER_QUOTA_ERROR_RE.test("You've hit your usage limit for GPT-5.")).toBe(true);
    expect(PROVIDER_QUOTA_ERROR_RE.test("Provider quota exceeded for this model.")).toBe(true);
    expect(PROVIDER_QUOTA_ERROR_RE.test("Model is at capacity right now.")).toBe(true);
  });

  it("does not match an unrelated capacity message", () => {
    expect(PROVIDER_QUOTA_ERROR_RE.test("Workspace storage capacity limit reached.")).toBe(false);
  });
});

describe("parseProviderQuotaResetTime", () => {
  it("parses the verbatim 2026-07-29 ACPX weekly-limit reset (month + day + timezone)", () => {
    const now = new Date("2026-07-29T08:00:00.000Z");
    const retryAt = parseProviderQuotaResetTime(
      "Internal error: You've hit your weekly limit · resets Jul 30 at 12pm (Europe/Rome).",
      now,
    );
    // 2026-07-30 12:00 Europe/Rome is CEST (UTC+2) => 10:00 UTC.
    expect(retryAt?.toISOString()).toBe("2026-07-30T10:00:00.000Z");
  });

  it("parses 'try again at' phrasing with an explicit timezone", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const retryAt = parseProviderQuotaResetTime(
      "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      now,
    );
    expect(retryAt?.toISOString()).toBe("2026-07-15T21:30:00.000Z");
  });

  it("treats a timezone-less reset clock as UTC and rolls to the next day when already past", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const retryAt = parseProviderQuotaResetTime("You've hit your usage limit. Try again at 4:30 PM.", now);
    expect(retryAt?.toISOString()).toBe("2026-07-16T16:30:00.000Z");
  });

  it("parses 24-hour clock reset times", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const retryAt = parseProviderQuotaResetTime("You've hit your usage limit. Try again at 21:30 (UTC).", now);
    expect(retryAt?.toISOString()).toBe("2026-07-15T21:30:00.000Z");
  });

  it("returns null when no reset time is present", () => {
    expect(parseProviderQuotaResetTime("Provider quota exceeded.", new Date())).toBeNull();
  });

  // PPC-3303: parsing "resets <month> <day>" against a `now` far enough past
  // that date (the common case for stranded-issue sweeps, which run long
  // after the original error text was captured) used to roll the date forward
  // a full year regardless of how recently it had passed -- a quota reset
  // "1 minute ago" got parked for 365 days. These cases pin the cliff and the
  // genuine year-wrap it must not regress.
  describe("explicit month/day reset already in the past (PPC-3303)", () => {
    it("returns null one minute after an explicit-date reset with a timezone (not +365 days)", () => {
      const now = new Date("2026-07-30T10:01:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12pm (Europe/Rome)", now);
      expect(retryAt).toBeNull();
    });

    it("still resolves the reset one minute before it passes (timezone branch)", () => {
      const now = new Date("2026-07-30T09:59:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12pm (Europe/Rome)", now);
      expect(retryAt?.toISOString()).toBe("2026-07-30T10:00:00.000Z");
    });

    it("returns null one minute after an explicit-date reset with no timezone (not +365 days)", () => {
      const now = new Date("2026-07-30T12:01:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12:00", now);
      expect(retryAt).toBeNull();
    });

    it("still resolves the reset one minute before it passes (no-timezone branch)", () => {
      const now = new Date("2026-07-30T11:59:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12:00", now);
      expect(retryAt?.toISOString()).toBe("2026-07-30T12:00:00.000Z");
    });

    it("returns null for a reset that passed a few weeks ago, well under the year-wrap floor", () => {
      const now = new Date("2026-08-15T00:00:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12pm (Europe/Rome)", now);
      expect(retryAt).toBeNull();
    });

    it("still rolls a genuine year-wrap forward a year (timezone branch, Dec 31 -> Jan 2)", () => {
      const now = new Date("2026-12-31T23:00:00.000Z");
      const retryAt = parseProviderQuotaResetTime("monthly limit reached, resets Jan 2 at 9am (Europe/Rome)", now);
      expect(retryAt?.toISOString()).toBe("2027-01-02T08:00:00.000Z");
    });

    it("still rolls a genuine year-wrap forward a year (no-timezone branch, Dec 31 -> Jan 2)", () => {
      const now = new Date("2026-12-31T23:00:00.000Z");
      const retryAt = parseProviderQuotaResetTime("monthly limit reached, resets Jan 2 at 09:00", now);
      expect(retryAt?.toISOString()).toBe("2027-01-02T09:00:00.000Z");
    });

    it("the recently-passed cliff holds a year later too (parser is a pure function of `now`, not the real clock)", () => {
      const now = new Date("2027-07-31T00:00:00.000Z");
      const retryAt = parseProviderQuotaResetTime("weekly limit reached, resets Jul 30 at 12pm (Europe/Rome)", now);
      expect(retryAt).toBeNull();
    });
  });
});
