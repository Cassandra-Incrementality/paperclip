import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows, getQuotaHealthSnapshot, resetQuotaHealthCacheForTests } from "../services/quota-windows.js";

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });
});

describe("getQuotaHealthSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetQuotaHealthCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetQuotaHealthCacheForTests();
  });

  function mockAdapter(getQuotaWindows: () => Promise<unknown>) {
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows },
    ] as never);
  }

  it("returns null before the first background fetch resolves, without invoking the adapter more than once", async () => {
    const getQuotaWindows = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    mockAdapter(getQuotaWindows);

    const cold = getQuotaHealthSnapshot({ now: 0 });
    expect(cold).toBeNull();
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);

    const warm = getQuotaHealthSnapshot({ now: 1_000 });
    expect(warm?.results).toEqual([{ provider: "anthropic", ok: true, windows: [] }]);
  });

  it("never re-invokes the provider adapter for repeated reads within the TTL window (proves the CLI isn't shelled out per health poll)", async () => {
    const getQuotaWindows = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    mockAdapter(getQuotaWindows);

    getQuotaHealthSnapshot({ now: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);

    for (const now of [1_000, 5_000, 15_000, 29_999]) {
      getQuotaHealthSnapshot({ now });
    }
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("refreshes in the background once the TTL expires, but still returns synchronously from cache", async () => {
    const getQuotaWindows = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    mockAdapter(getQuotaWindows);

    getQuotaHealthSnapshot({ now: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);

    const stale = getQuotaHealthSnapshot({ now: 30_000 });
    expect(stale?.results).toEqual([{ provider: "anthropic", ok: true, windows: [] }]);
    expect(getQuotaWindows).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent reads against a single in-flight fetch instead of piling on more CLI shell-outs", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const getQuotaWindows = vi.fn(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    mockAdapter(getQuotaWindows);

    getQuotaHealthSnapshot({ now: 0 });
    getQuotaHealthSnapshot({ now: 0 });
    getQuotaHealthSnapshot({ now: 0 });
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);

    resolveFetch?.({ provider: "anthropic", ok: true, windows: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(getQuotaHealthSnapshot({ now: 0 })?.results).toEqual([{ provider: "anthropic", ok: true, windows: [] }]);
  });

  it("degrades silently (stays null, never throws) when the underlying fetch fails", async () => {
    vi.mocked(listServerAdapters).mockImplementation(() => {
      throw new Error("adapter registry unavailable");
    });

    expect(() => getQuotaHealthSnapshot({ now: 0 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(getQuotaHealthSnapshot({ now: 0 })).toBeNull();
  });
});
