import type { ContentBrief, ContentEntity } from "./metadata_quality";

export const MAX_ENTITY_LOOKUPS = 3;

export interface LookupHit {
  query: string;
  original_name: string;
  zh_name: string;
  summary_zh: string;
  source_url: string;
  confidence: number;
}

const CJK = /[\u3400-\u9fff]/;

export function hasCjk(value: string): boolean {
  return CJK.test(value);
}

export function latinPersonLookupQueries(brief: ContentBrief, limit = MAX_ENTITY_LOOKUPS): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const entity of brief.entities) {
    if (entity.type !== "person") continue;
    const original = entity.original_name.trim();
    if (!/[A-Za-z]{2,}/.test(original)) continue;
    if (hasCjk(entity.zh_name)) continue;
    const key = original.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(original);
    if (queries.length >= limit) break;
  }
  return queries;
}

export function applyLookupsToBrief(brief: ContentBrief, hits: readonly LookupHit[]): ContentBrief {
  if (hits.length === 0) return brief;
  const evidence = [...brief.evidence];
  const entities = brief.entities.map(entity => ({ ...entity, evidence_ids: [...entity.evidence_ids] }));
  const usedIds = new Set(evidence.map(item => item.id));
  hits.forEach((hit, index) => {
    let id = `lookup-${index + 1}`;
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);
    evidence.push({
      id,
      kind: "lookup",
      summary_zh: `${hit.original_name} → ${hit.zh_name}（${hit.summary_zh}）`,
    });
    const target = entities.find(entity => (
      entity.type === "person"
      && entity.original_name.trim().toLowerCase() === hit.original_name.trim().toLowerCase()
    ));
    if (!target) return;
    if (hasCjk(hit.zh_name)) target.zh_name = hit.zh_name;
    if (!target.evidence_ids.includes(id)) target.evidence_ids.push(id);
    target.confidence = Math.max(target.confidence, hit.confidence);
  });
  return { ...brief, evidence, entities };
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export async function lookupWikipediaZh(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<LookupHit | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const url = `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(trimmed)}&limit=1&namespace=0&format=json`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "bili-publisher-grok-v2/1.0 (local draft helper)" },
  });
  if (!response.ok) return null;
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length < 4) return null;
  const titles = payload[1];
  const descriptions = payload[2];
  const urls = payload[3];
  const title = Array.isArray(titles) ? String(titles[0] || "").trim() : "";
  if (!title) return null;
  const summary = Array.isArray(descriptions) ? String(descriptions[0] || "").trim() : "";
  const sourceUrl = Array.isArray(urls) ? String(urls[0] || "").trim() : "";
  return {
    query: trimmed,
    original_name: trimmed,
    zh_name: title,
    summary_zh: summary || `维基百科条目：${title}`,
    source_url: sourceUrl,
    confidence: hasCjk(title) ? 0.85 : 0.4,
  };
}

export async function lookupEntities(
  brief: ContentBrief,
  options: { fetch?: FetchLike; max?: number } = {},
): Promise<LookupHit[]> {
  const queries = latinPersonLookupQueries(brief, options.max ?? MAX_ENTITY_LOOKUPS);
  const hits: LookupHit[] = [];
  for (const query of queries) {
    try {
      const hit = await lookupWikipediaZh(query, options.fetch ?? fetch);
      if (hit) hits.push(hit);
    } catch {
      // Host-owned lookup is best-effort; analysis must still complete.
    }
  }
  return hits;
}

export function lookupTouchedEntities(brief: ContentBrief, hits: readonly LookupHit[]): ContentEntity[] {
  const names = new Set(hits.map(hit => hit.original_name.trim().toLowerCase()));
  return brief.entities.filter(entity => names.has(entity.original_name.trim().toLowerCase()));
}
