import { useEffect } from "react";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const ACTIVE_LIMIT = 50;
const RECENT_LIMIT = 12;

export function DashboardLive() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Live runs" },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? "Create a company to view live runs." : "Select a company to view live runs."}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">Live agent runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Currently running agents at the top, recent completed runs below.
        </p>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title="Live now"
        filterStatuses="active"
        minRunCount={0}
        fetchLimit={ACTIVE_LIMIT}
        cardLimit={ACTIVE_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-[420px]"
        emptyMessage="No agents are running right now."
        queryScope="dashboard-live-active"
        showMoreLink={false}
      />

      <div className="border-t border-border/60 pt-6">
        <ActiveAgentsPanel
          companyId={selectedCompanyId}
          title={`Recent runs (last ${RECENT_LIMIT})`}
          filterStatuses="finished"
          minRunCount={RECENT_LIMIT * 2}
          fetchLimit={RECENT_LIMIT * 2}
          cardLimit={RECENT_LIMIT}
          gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
          cardClassName="h-[420px]"
          emptyMessage="No recent runs."
          queryScope="dashboard-live-recent"
          showMoreLink={false}
        />
      </div>
    </div>
  );
}
