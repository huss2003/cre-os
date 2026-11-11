/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { chunkSource, embeddingProvider, vecLiteral, type EmbeddingProvider, type SourceType } from "./retrieval";

/**
 * Incremental indexer for mudar.doc_chunk. Called by the `assistant.embed` job with the SERVICE-ROLE client, so every
 * query filters workspace_id explicitly (S2). Chunks inherit the source row's classification + owner_user_id so RLS on
 * doc_chunk mirrors the source. Unchanged chunks (same content_hash) are never rewritten or re-embedded.
 */
interface SourceSpec { table: string; select: string; pages: (r: any) => string[] | null; text: (r: any) => string | null; extra?: (q: any) => any }
export const SOURCES: Record<SourceType, SourceSpec> = {
  attachment: { table: "assistant_attachment", select: "id, page_texts, extracted_text", pages: (r) => (Array.isArray(r.page_texts) && r.page_texts.length > 1 ? r.page_texts : null), text: (r) => r.extracted_text },
  meeting_note: { table: "meeting_note", select: "id, text", pages: () => null, text: (r) => r.text },
  interaction: { table: "interaction", select: "id, subject, summary", pages: () => null, text: (r) => [r.subject, r.summary].filter(Boolean).join("\n") },
  document: { table: "legal_document", select: "id, title, text_content", pages: (r) => (String(r.text_content ?? "").includes("\f") ? String(r.text_content).split(/\f/) : null), text: (r) => r.text_content },
  memory: { table: "assistant_memory", select: "id, content, status", pages: () => null, text: (r) => (r.status === "active" ? r.content : null) },
};

export interface EmbedStats { sources: number; chunksWritten: number; chunksDeleted: number; embedded: number; skippedNoProvider: boolean; timedOut: boolean; errors: string[] }

export async function indexWorkspace(admin: any, workspaceId: string, opts: { since?: string | null; batch?: number; deadlineMs?: number; provider?: EmbeddingProvider | null; types?: SourceType[]; sourceIds?: string[] } = {}): Promise<EmbedStats> {
  const deadline = Date.now() + (opts.deadlineMs ?? 25_000);
  const batch = opts.batch ?? 100;
  const provider = opts.provider === undefined ? embeddingProvider() : opts.provider;
  const st: EmbedStats = { sources: 0, chunksWritten: 0, chunksDeleted: 0, embedded: 0, skippedNoProvider: !provider, timedOut: false, errors: [] };

  for (const type of opts.types ?? (Object.keys(SOURCES) as SourceType[])) {
    if (Date.now() > deadline) { st.timedOut = true; break; }
    const spec = SOURCES[type];
    let q = admin.from(spec.table).select(`${spec.select}, classification, owner_user_id, archived_at, updated_at`).eq("workspace_id", workspaceId).order("updated_at", { ascending: false }).limit(batch);
    if (opts.since) q = q.gt("updated_at", opts.since);
    if (opts.sourceIds?.length) q = q.in("id", opts.sourceIds);
    const { data: rows, error } = await q;
    if (error) { st.errors.push(`${type}: ${error.message}`); continue; }
    for (const r of (rows ?? []) as any[]) {
      if (Date.now() > deadline) { st.timedOut = true; break; }
      st.sources++;
      const { data: existing } = await admin.from("doc_chunk").select("id, chunk_index, content_hash").eq("workspace_id", workspaceId).eq("source_type", type).eq("source_id", r.id);
      const have = new Map<number, string>(((existing ?? []) as any[]).map((c) => [c.chunk_index, c.content_hash]));
      const text = spec.text(r);
      const chunks = r.archived_at || !text ? [] : chunkSource({ pages: spec.pages(r), text });
      const changed = chunks.filter((c) => have.get(c.chunkIndex) !== c.contentHash);
      if (changed.length) {
        const { error: e } = await admin.from("doc_chunk").upsert(changed.map((c) => ({
          workspace_id: workspaceId, source_type: type, source_id: r.id, page: c.page, chunk_index: c.chunkIndex, text: c.text, content_hash: c.contentHash,
          embedding: null, model: null, classification: r.classification, owner_user_id: r.owner_user_id, archived_at: null,
        })), { onConflict: "workspace_id,source_type,source_id,chunk_index" });
        if (e) st.errors.push(`${type}/${r.id}: ${e.message}`); else st.chunksWritten += changed.length;
      }
      const stale = [...have.keys()].filter((i) => i >= chunks.length);
      if (stale.length) {
        await admin.from("doc_chunk").delete().eq("workspace_id", workspaceId).eq("source_type", type).eq("source_id", r.id).gte("chunk_index", chunks.length);
        st.chunksDeleted += stale.length;
      }
    }
  }

  if (provider) {
    try {
      const { assertProcessingAllowed } = await import("@/lib/ai/gateway");
      await assertProcessingAllowed(workspaceId, "corporate_confidential", []);
    } catch (e) { st.errors.push(`embedding not allowed: ${(e as Error).message}`); return st; }
    while (Date.now() < deadline) {
      let tq = admin.from("doc_chunk").select("id, text").eq("workspace_id", workspaceId).is("embedding", null).is("archived_at", null);
      if (opts.sourceIds?.length) tq = tq.in("source_id", opts.sourceIds);
      const { data: todo } = await tq.limit(64);
      if (!todo?.length) break;
      try {
        const vecs = await provider.embed(todo.map((c: any) => c.text), "document");
        for (let i = 0; i < todo.length; i++) {
          const { error } = await admin.from("doc_chunk").update({ embedding: vecLiteral(vecs[i]), model: provider.name }).eq("workspace_id", workspaceId).eq("id", todo[i].id);
          if (!error) st.embedded++;
        }
      } catch (e) { st.errors.push(String((e as Error).message).slice(0, 200)); break; }
    }
    if (Date.now() >= deadline) st.timedOut = true;
  }
  return st;
}
