import "server-only";
import type { Db } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export async function listLegalDocuments(db: Db, workspaceId: string) {
  const { data, error } = await db.from("legal_document").select("id, title, doc_kind, family_key, version, status, ocr_unverified, created_at").eq("workspace_id", workspaceId).is("archived_at", null).order("family_key").order("version", { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function legalDocument(db: Db, workspaceId: string, id: string) {
  const [{ data: doc }, { data: clauses }, { data: comps }] = await Promise.all([
    db.from("legal_document").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle(),
    db.from("clause_extract").select("id, clause_type, heading, clause_text, locator, extracted_values, extraction_method, needs_review").eq("workspace_id", workspaceId).eq("document_id", id).order("created_at"),
    db.from("clause_comparison").select("id, base_document_id, compare_document_id, created_at").eq("workspace_id", workspaceId).or(`base_document_id.eq.${id},compare_document_id.eq.${id}`).limit(20),
  ]);
  return { doc: doc as Row | null, clauses: (clauses ?? []) as Row[], comparisons: (comps ?? []) as Row[] };
}

export async function clauseComparison(db: Db, workspaceId: string, id: string) {
  const { data } = await db.from("clause_comparison").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: docs } = await db.from("legal_document").select("id, title, version").eq("workspace_id", workspaceId).in("id", [data.base_document_id, data.compare_document_id]);
  return { cmp: data as Row, docs: (docs ?? []) as Row[] };
}
