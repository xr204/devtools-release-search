import type { SearchHit } from "./infrai_search_client";

export type PublishedDiagnostic = {
  id: string;
  title: string;
  kind: string;
  release: string;
  relevance: number;
};

export function publishSearchResults(
  hits: SearchHit[],
  reranked: Array<{ index: number; relevance_score: number }>,
  minimumRelevance = 0.55,
): PublishedDiagnostic[] {
  return reranked.flatMap(({ index, relevance_score }) => {
    const hit = hits[index];
    const metadata = hit?.metadata;
    if (!hit || !metadata || relevance_score < minimumRelevance) return [];
    if (typeof metadata.title !== "string" || typeof metadata.kind !== "string" || typeof metadata.release !== "string") return [];
    return [{ id: hit.id, title: metadata.title, kind: metadata.kind, release: metadata.release, relevance: relevance_score }];
  });
}
