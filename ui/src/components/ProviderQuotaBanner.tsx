import { AlertTriangle } from "lucide-react";
import type { HealthStatus } from "../api/health";
import { formatQuotaResetTime, QUOTA_USED_PERCENT_WARNING_THRESHOLD } from "./ClaudeSubscriptionPanel";
import { providerDisplayName } from "@/lib/utils";

type HotWindow = {
  provider: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

function collectHotWindows(providerQuota: HealthStatus["providerQuota"]): HotWindow[] {
  if (!providerQuota) return [];
  const hot: HotWindow[] = [];
  for (const result of providerQuota.results) {
    if (!result.ok) continue;
    for (const window of result.windows) {
      if (window.usedPercent != null && window.usedPercent >= QUOTA_USED_PERCENT_WARNING_THRESHOLD) {
        hot.push({
          provider: result.provider,
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
        });
      }
    }
  }
  return hot.sort((a, b) => b.usedPercent - a.usedPercent);
}

export function ProviderQuotaBanner({ providerQuota }: { providerQuota?: HealthStatus["providerQuota"] }) {
  const hotWindows = collectHotWindows(providerQuota);
  if (hotWindows.length === 0) return null;

  const worst = hotWindows[0]!;
  const resetLabel = formatQuotaResetTime(worst.resetsAt);
  const extraCount = hotWindows.length - 1;

  return (
    <div className="border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100">
      <div className="flex flex-col gap-1 px-3 py-2.5 md:flex-row md:items-center md:gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Shared quota at cap</span>
        </div>
        <p className="text-sm">
          {providerDisplayName(worst.provider)} {worst.label} is at {worst.usedPercent}% used
          {resetLabel ? ` — expect stalls until ${resetLabel}` : ""}
          {extraCount > 0 ? ` (+${extraCount} more window${extraCount === 1 ? "" : "s"} near cap)` : ""}.
        </p>
      </div>
    </div>
  );
}
