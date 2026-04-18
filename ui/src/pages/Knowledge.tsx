import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { knowledgeApi } from "../api/knowledge";
import type { WikiDocument, WikiSearchHit } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BookOpen, Search } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  manual: "Manual",
  crystallized: "Crystallized",
  procedural: "Procedural",
  reference: "Reference",
};

const TIER_LABELS: Record<string, string> = {
  working: "Working",
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function Knowledge() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const statsQuery = useQuery({
    queryKey: ["knowledge", "stats", selectedCompanyId],
    queryFn: () => knowledgeApi.stats(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recentQuery = useQuery({
    queryKey: ["knowledge", "recent", selectedCompanyId],
    queryFn: () => knowledgeApi.list(selectedCompanyId!, { limit: 50 }),
    enabled: !!selectedCompanyId && debouncedQuery === "",
  });

  const searchQuery = useQuery({
    queryKey: ["knowledge", "search", selectedCompanyId, debouncedQuery],
    queryFn: () => knowledgeApi.search(selectedCompanyId!, debouncedQuery, 30),
    enabled: !!selectedCompanyId && debouncedQuery.length > 0,
  });

  const items: Array<WikiDocument | WikiSearchHit> = useMemo(() => {
    if (debouncedQuery) return searchQuery.data?.hits ?? [];
    return recentQuery.data?.items ?? [];
  }, [debouncedQuery, recentQuery.data, searchQuery.data]);

  const isLoading = (debouncedQuery ? searchQuery.isLoading : recentQuery.isLoading);

  if (!selectedCompanyId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Knowledge</h1>
        </div>
        {statsQuery.data && (
          <div className="text-sm text-muted-foreground">
            {statsQuery.data.total} entries · {Object.entries(statsQuery.data.byKind).map(([k, v]) => `${KIND_LABELS[k] ?? k}: ${v}`).join(" · ")}
          </div>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search wiki entries by title, summary, or body…"
          className="pl-9"
        />
      </div>

      {isLoading && <PageSkeleton />}

      {!isLoading && items.length === 0 && (
        <EmptyState
          icon={BookOpen}
          message={
            debouncedQuery
              ? `No wiki entries matched "${debouncedQuery}".`
              : "Wiki entries appear here as agents complete work and crystallize what they learn."
          }
        />
      )}

      {!isLoading && items.length > 0 && (
        <div className="space-y-3">
          {items.map((doc) => (
            <Card key={doc.id} className="p-4 hover:bg-accent/40 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium truncate">{doc.title ?? "(untitled)"}</h3>
                    <Badge variant="secondary" className="text-xs">{KIND_LABELS[doc.kind] ?? doc.kind}</Badge>
                    <Badge variant="outline" className="text-xs">{TIER_LABELS[doc.decayTier] ?? doc.decayTier}</Badge>
                    {"similarity" in doc && (
                      <span className="text-xs text-muted-foreground">match {(doc.similarity * 100).toFixed(0)}%</span>
                    )}
                  </div>
                  {doc.summary && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{doc.summary}</p>
                  )}
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {doc.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs px-1.5 py-0">{tag}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {relativeTime(doc.updatedAt)}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
