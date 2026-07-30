import { describe, expect, it } from "vitest";
import { parseProviderQuotaResetTime } from "@paperclipai/adapter-utils";
import { extractClaudeRetryNotBefore } from "@paperclipai/adapter-claude-local/server";
import { extractCodexRetryNotBefore } from "@paperclipai/adapter-codex-local/server";

// PPC-3260: three reset-time parsers used to exist (recovery/service.ts,
// claude-local/parse.ts, codex-local/parse.ts) with divergent timezone
// fallbacks. All three now delegate to the single implementation in
// packages/adapter-utils/src/provider-quota.ts. This test proves that by
// checking every consumer resolves the *same* clock+timezone combination to
// the *same* instant -- if any consumer still carried its own copy, a
// divergent fallback (or a rounding/DST difference) would show up here.
describe("provider-quota reset parser has a single source of truth (PPC-3260)", () => {
  it("resolves an identical explicit-timezone reset window the same way for every consumer", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const expected = "2026-07-15T21:30:00.000Z";

    expect(parseProviderQuotaResetTime("try again at 4:30 PM (America/Chicago)", now)?.toISOString()).toBe(
      expected,
    );
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your session limit - resets at 4:30pm (America/Chicago)." },
        now,
      )?.toISOString(),
    ).toBe(expected);
    expect(
      extractCodexRetryNotBefore(
        {
          errorMessage:
            "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).",
        },
        now,
      )?.toISOString(),
    ).toBe(expected);
  });

  it("standardizes the no-timezone fallback on UTC for every consumer", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const expected = "2026-07-16T16:30:00.000Z";

    expect(parseProviderQuotaResetTime("try again at 4:30 PM", now)?.toISOString()).toBe(expected);
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your session limit - resets at 4:30pm." },
        now,
      )?.toISOString(),
    ).toBe(expected);
    expect(
      extractCodexRetryNotBefore(
        {
          errorMessage:
            "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM.",
        },
        now,
      )?.toISOString(),
    ).toBe(expected);
  });
});
