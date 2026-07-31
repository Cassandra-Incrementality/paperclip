import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type QuotaHealthSnapshot = {
  fetchedAt: string;
  results: ProviderQuotaResult[];
};

const QUOTA_HEALTH_CACHE_TTL_MS = 30_000;

let quotaHealthCache: { snapshot: QuotaHealthSnapshot; expiresAt: number } | null = null;
let quotaHealthRefreshInFlight: Promise<void> | null = null;

function refreshQuotaHealthCache(now: number): Promise<void> {
  if (quotaHealthRefreshInFlight) return quotaHealthRefreshInFlight;
  quotaHealthRefreshInFlight = fetchAllQuotaWindows()
    .then((results) => {
      quotaHealthCache = {
        snapshot: { fetchedAt: new Date(now).toISOString(), results },
        expiresAt: now + QUOTA_HEALTH_CACHE_TTL_MS,
      };
    })
    .catch((error) => {
      logger.warn({ err: error }, "Provider quota health refresh failed");
    })
    .finally(() => {
      quotaHealthRefreshInFlight = null;
    });
  return quotaHealthRefreshInFlight;
}

/**
 * Non-blocking read for the /api/health route. fetchAllQuotaWindows() shells out
 * to provider CLIs with a QUOTA_PROVIDER_TIMEOUT_MS-bounded (20s) wait, far too
 * slow to await inline in a health response, so this always returns synchronously
 * from cache (or null before the first successful fetch) and kicks a deduped
 * background refresh when the cache is stale or missing.
 */
export function getQuotaHealthSnapshot(opts: { now?: number } = {}): QuotaHealthSnapshot | null {
  const now = opts.now ?? Date.now();
  if (!quotaHealthCache || now >= quotaHealthCache.expiresAt) {
    void refreshQuotaHealthCache(now);
  }
  return quotaHealthCache?.snapshot ?? null;
}

export function resetQuotaHealthCacheForTests(): void {
  quotaHealthCache = null;
  quotaHealthRefreshInFlight = null;
}
