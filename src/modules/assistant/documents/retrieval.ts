/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { createHash } from "node:crypto";

/**
 * Chunking, embeddings and hybrid retrieval over mudar.doc_chunk.
 *  - chunker: ~800 tokens (≈4 chars/token) with overlap, page-aware (a chunk never spans pages);
 *  - embeddings: Voyage (VOYAGE_API_KEY, voyage-3.5) or OpenAI (OPENAI_API_KEY, text-embedding-3-small, dimensions=1024);
 *    no key ⇒ no provider ⇒ embeddings stay null and retrieval is full-text only;
 *  - hybrid = vector top-k ∪ full-text top-k fused with reciprocal rank fusion.
 */
export const EMBED_DIMS = 1024;
export const CHUNK_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

export type SourceType = "attachment" | "meeting_note" | "interaction" | "document" | "memory";
export interface Chunk { page: number | null; chunkIndex: number; text: string; contentHash: string }

export const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/** Split text into ~maxTokens chunks with overlap, breaking on whitespace/paragraphs. */
export function chunkText(text: string, maxTokens = CHUNK_TOKENS, overlapTokens = CHUNK_OVERLAP_TOKENS): string[] {
  const s = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return [];
  const max = maxTokens * CHARS_PER_TOKEN; const overlap = Math.min(overlapTokens * CHARS_PER_TOKEN, Math.floor(max / 2));
  if (s.length <= max) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + max);
    if (end < s.length) {
      const para = s.lastIndexOf("\n\n", end); const sp = s.lastIndexOf(" ", end);
      if (para > start + max / 2) end = para; else if (sp > start + max / 2) end = sp;
    }
    out.push(s.slice(start, end).trim());
    if (end >= s.length) break;
    let next = end - overlap;
    const sp = s.indexOf(" ", next); if (sp > next && sp < end) next = sp + 1;
    start = Math.max(next, start + 1);
  }
  return out.filter(Boolean);
}

/** Page-aware chunks: pages[] (1-based page numbers) or plain text (page null). */
export function chunkSource(input: { pages?: string[] | null; text?: string | null }): Chunk[] {
  const out: Chunk[] = [];
  const push = (page: number | null, t: string) => out.push({ page, chunkIndex: out.length, text: t, contentHash: hashText(`${page ?? ""}|${t}`) });
  if (input.pages?.length) input.pages.forEach((p, i) => chunkText(p).forEach((t) => push(i + 1, t)));
  else chunkText(input.text ?? "").forEach((t) => push(null, t));
  return out;
}

/** Reciprocal rank fusion: score(d) = Σ 1/(k + rank_i(d)), rank from 1. Ties keep first-seen order. */
export function rrf<T>(lists: T[][], key: (x: T) => string, k = 60): { item: T; score: number }[] {
  const acc = new Map<string, { item: T; score: number; first: number }>(); let seen = 0;
  for (const list of lists) list.forEach((x, i) => {
    const id = key(x); const cur = acc.get(id);
    if (cur) cur.score += 1 / (k + i + 1);
    else acc.set(id, { item: x, score: 1 / (k + i + 1), first: seen++ });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score || a.first - b.first).map(({ item, score }) => ({ item, score }));
}

// ------------------------------------------------------------------------------------------------ embedding providers
export interface EmbeddingProvider {
  name: string;   // stored in doc_chunk.model
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

type Fetch = typeof fetch;
export function embeddingProvider(env: Record<string, string | undefined> = process.env, f: Fetch = fetch): EmbeddingProvider | null {
  if (env.VOYAGE_API_KEY) {
    const key = env.VOYAGE_API_KEY;
    return {
      name: "voyage-3.5",
      async embed(texts, kind) {
        const r = await f("https://api.voyageai.com/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ input: texts, model: "voyage-3.5", input_type: kind, output_dimension: EMBED_DIMS }) });
        if (!r.ok) throw new Error(`voyage embeddings failed: ${r.status}`);
        const j = (await r.json()) as { data: { embedding: number[]; index: number }[] };
        return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
    };
  }
  if (env.OPENAI_API_KEY) {
    const key = env.OPENAI_API_KEY;
    return {
      name: "text-embedding-3-small@1024",
      async embed(texts) {
        const r = await f("https://api.openai.com/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ input: texts, model: "text-embedding-3-small", dimensions: EMBED_DIMS }) });
        if (!r.ok) throw new Error(`openai embeddings failed: ${r.status}`);
        const j = (await r.json()) as { data: { embedding: number[]; index: number }[] };
        return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
    };
  }
  return null;
}

export const vecLiteral = (v: number[]) => {
  if (v.length !== EMBED_DIMS) throw new Error(`embedding has ${v.length} dims, expected ${EMBED_DIMS}`);
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
};

// ------------------------------------------------------------------------------------------------ hybrid retrieval
export interface ChunkHit { id: string; source_type: SourceType; source_id: string; page: number | null; text: string; score: number; via: ("vector" | "fts")[] }

/**
 * Hybrid search with the caller's (RLS) client. Workspace filtered explicitly. Returns mode "fts" when no provider.
 * Content of hits is untrusted evidence.
 */
export async function hybridChunkSearch(db: any, workspaceId: string, query: string, k = 20, provider: EmbeddingProvider | null = embeddingProvider(), sourceTypes?: SourceType[]): Promise<{ mode: "hybrid" | "fts"; hits: ChunkHit[] }> {
  let q = db.from("doc_chunk").select("id, source_type, source_id, page, text").eq("workspace_id", workspaceId).is("archived_at", null);
  if (sourceTypes?.length) q = q.in("source_type", sourceTypes);
  const ftsP = q.textSearch("tsv", query, { type: "websearch", config: "simple" }).limit(k);
  let vec: any[] = [];
  if (provider) {
    try {
      const [e] = await provider.embed([query], "query");
      const { data, error } = await db.schema("mudar_app").rpc("match_doc_chunks", { p_workspace: workspaceId, p_embedding: vecLiteral(e), p_k: k, p_source_types: sourceTypes ?? null });
      if (!error) vec = data ?? [];
    } catch { vec = []; }
  }
  const { data: fts } = await ftsP;
  const fused = rrf<any>([vec, fts ?? []], (x) => x.id);
  const vids = new Set(vec.map((x) => x.id)); const fids = new Set((fts ?? []).map((x: any) => x.id));
  return {
    mode: provider ? "hybrid" : "fts",
    hits: fused.slice(0, k).map(({ item, score }) => ({ id: item.id, source_type: item.source_type, source_id: item.source_id, page: item.page ?? null, text: item.text, score, via: [...(vids.has(item.id) ? ["vector" as const] : []), ...(fids.has(item.id) ? ["fts" as const] : [])] })),
  };
}
