import "server-only";
import type { Db } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export async function listLegalDocuments(db: Db, workspaceId: string) {
  const { data, error } = await db.from("legal_document").select("id, title, doc_kind, family_key, version, status, ocr_unverified, ocr_status, file_kind, page_count, source_object_id, created_at").eq("workspace_id", workspaceId).is("archived_at", null).order("family_key").order("version", { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function legalDocument(db: Db, workspaceId: string, id: string) {
  const [{ data: doc }, { data: clauses }, { data: comps }] = await Promise.all([
    db.from("legal_document").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle(),
    db.from("clause_extract").select("id, clause_type, heading, clause_text, locator, extracted_values, extraction_method, needs_review, validation").eq("workspace_id", workspaceId).eq("document_id", id).order("created_at"),
    db.from("clause_comparison").select("id, base_document_id, compare_document_id, base_version, compare_version, same_family, created_at").eq("workspace_id", workspaceId).or(`base_document_id.eq.${id},compare_document_id.eq.${id}`).limit(20),
  ]);
  return { doc: doc as Row | null, clauses: (clauses ?? []) as Row[], comparisons: (comps ?? []) as Row[] };
}

export async function clauseComparison(db: Db, workspaceId: string, id: string) {
  const { data } = await db.from("clause_comparison").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: docs } = await db.from("legal_document").select("id, title, version, family_key, file_kind, ocr_unverified").eq("workspace_id", workspaceId).in("id", [data.base_document_id, data.compare_document_id]);
  return { cmp: data as Row, docs: (docs ?? []) as Row[] };
}

/** Pickers for "related lease / company / building" on upload (RLS-filtered). */
export async function legalLinkOptions(db: Db, workspaceId: string) {
  const [{ data: leases }, { data: orgs }, { data: assets }] = await Promise.all([
    db.from("lease").select("id, tenant_org_id, tenant_name_raw, asset_id, contractual_expiry").eq("workspace_id", workspaceId).is("archived_at", null).order("contractual_expiry", { ascending: true, nullsFirst: false }).limit(500),
    db.from("organisation").select("id, display_name").eq("workspace_id", workspaceId).is("archived_at", null).order("display_name").limit(1000),
    db.from("asset").select("id, name").eq("workspace_id", workspaceId).is("archived_at", null).order("name").limit(1000),
  ]);
  const orgName = new Map(((orgs ?? []) as Row[]).map((o) => [String(o.id), String(o.display_name)]));
  const assetName = new Map(((assets ?? []) as Row[]).map((a) => [String(a.id), String(a.name)]));
  return {
    leases: ((leases ?? []) as Row[]).map((l) => ({ id: String(l.id), label: `${l.tenant_org_id ? orgName.get(String(l.tenant_org_id)) ?? "tenant" : String(l.tenant_name_raw ?? "tenant unknown")} · ${l.asset_id ? assetName.get(String(l.asset_id)) ?? "building" : "building unknown"}${l.contractual_expiry ? ` · exp ${String(l.contractual_expiry)}` : ""}` })),
    orgs: [...orgName].map(([id, label]) => ({ id, label })),
    assets: [...assetName].map(([id, label]) => ({ id, label })),
  };
}
