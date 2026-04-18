import { api } from "./client";

export interface WikiDocument {
  id: string;
  companyId: string;
  title: string | null;
  summary: string | null;
  latestBody: string;
  kind: string;
  tags: string[] | null;
  confidence: number;
  sourceCount: number;
  decayTier: string;
  lastReinforcedAt: string | null;
  supersededById: string | null;
  sourceIssueId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiSearchHit {
  id: string;
  title: string | null;
  summary: string | null;
  kind: string;
  tags: string[] | null;
  confidence: number;
  sourceCount: number;
  decayTier: string;
  similarity: number;
  updatedAt: string;
}

export interface WikiStats {
  total: number;
  byKind: Record<string, number>;
  byTier: Record<string, number>;
  details: Array<{ kind: string; decayTier: string; count: number }>;
}

export interface UpsertWikiInput {
  id?: string;
  title: string;
  body: string;
  summary?: string | null;
  kind?: string;
  tags?: string[];
  decayTier?: string;
  sourceIssueId?: string | null;
}

export const knowledgeApi = {
  list: (companyId: string, opts?: { limit?: number; offset?: number }) =>
    api.get<{ items: WikiDocument[]; limit: number; offset: number }>(
      `/companies/${companyId}/knowledge?limit=${opts?.limit ?? 50}&offset=${opts?.offset ?? 0}`,
    ),
  stats: (companyId: string) => api.get<WikiStats>(`/companies/${companyId}/knowledge/stats`),
  search: (companyId: string, query: string, limit = 20) =>
    api.get<{ query: string; hits: WikiSearchHit[] }>(
      `/companies/${companyId}/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  get: (companyId: string, docId: string) =>
    api.get<WikiDocument>(`/companies/${companyId}/knowledge/${docId}`),
  upsert: (companyId: string, input: UpsertWikiInput) =>
    api.put<WikiDocument>(`/companies/${companyId}/knowledge`, input),
  reinforce: (companyId: string, docId: string) =>
    api.post<WikiDocument>(`/companies/${companyId}/knowledge/${docId}/reinforce`, {}),
  crystallize: (companyId: string, issueId: string) =>
    api.post<{ created: WikiDocument[] }>(`/companies/${companyId}/knowledge/crystallize`, { issueId }),
};
