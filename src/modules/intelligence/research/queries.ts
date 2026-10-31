import "server-only";
import type { Db } from "@/lib/supabase/server";
import { nameMap } from "./service";
import { jobMoveStates } from "../network/service";

type Row = Record<string, unknown>;

export async function orgOptions(db: Db, workspaceId: string, limit = 500) {
  const { data } = await db.from("organisation").select("id, display_name").eq("workspace_id", workspaceId).is("archived_at", null).order("display_name").limit(limit);
  return ((data ?? []) as Row[]).map((o) => ({ id: String(o.id), name: String(o.display_name) }));
}

export async function personOptions(db: Db, workspaceId: string, limit = 500) {
  const { data } = await db.from("person").select("id, full_name").eq("workspace_id", workspaceId).is("archived_at", null).order("full_name").limit(limit);
  return ((data ?? []) as Row[]).map((o) => ({ id: String(o.id), name: String(o.full_name) }));
}

export async function watchlistView(db: Db, workspaceId: string) {
  const [{ data: watch }, { data: doss }] = await Promise.all([
    db.from("watchlist").select("id, org_id, tier, reason, next_due_at, last_researched_at, active").eq("workspace_id", workspaceId).is("archived_at", null).order("next_due_at").limit(500),
    db.from("research_dossier").select("org_id, version, generated_at, synthesis_status, expired_claim_count, evidence_count, next_refresh_at").eq("workspace_id", workspaceId).eq("is_current", true).limit(3000),
  ]);
  const w = (watch ?? []) as Row[];
  const d = (doss ?? []) as Row[];
  const names = await nameMap(db, workspaceId, "organisation", [...w.map((x) => x.org_id as string), ...d.map((x) => x.org_id as string)]);
  const watched = new Set(w.map((x) => String(x.org_id)));
  return {
    watch: w.map((x) => ({ ...x, name: names.get(String(x.org_id)) ?? "(restricted)", dossier: d.find((y) => y.org_id === x.org_id) ?? null }) as Row & { name: string; dossier: Row | null }),
    unwatchedDossiers: d.filter((y) => !watched.has(String(y.org_id))).map((y) => ({ ...y, name: names.get(String(y.org_id)) ?? "(restricted)" }) as Row & { name: string }),
  };
}

export async function openFindings(db: Db, workspaceId: string, limit = 50) {
  const { data } = await db.from("evidence_finding").select("id, kind, subject_type, subject_id, detail, severity, detected_at").eq("workspace_id", workspaceId).eq("status", "open").order("detected_at", { ascending: false }).limit(limit);
  return (data ?? []) as Row[];
}

export async function setFindingStatus(db: Db, workspaceId: string, id: string, status: "resolved" | "dismissed") {
  const { error } = await db.from("evidence_finding").update({ status, resolved_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", id);
  if (error) throw error;
}

export async function dossierPage(db: Db, workspaceId: string, orgId: string) {
  const [{ data: org }, { data: cur }, { data: versions }, { data: watch }, { data: claims }] = await Promise.all([
    db.from("organisation").select("id, display_name").eq("workspace_id", workspaceId).eq("id", orgId).maybeSingle(),
    db.from("research_dossier").select("*").eq("workspace_id", workspaceId).eq("org_id", orgId).eq("is_current", true).maybeSingle(),
    db.from("research_dossier").select("id, version, generated_at, synthesis_status").eq("workspace_id", workspaceId).eq("org_id", orgId).order("version", { ascending: false }).limit(10),
    db.from("watchlist").select("tier, next_due_at, reason").eq("workspace_id", workspaceId).eq("org_id", orgId).maybeSingle(),
    db.from("signal_claim").select("id, claim_type, predicate, evidence_tier, source_url, observed_on, expires_on, status, classification, value_json").eq("workspace_id", workspaceId).eq("subject_type", "organisation").eq("subject_id", orgId).is("archived_at", null).order("observed_on", { ascending: false }).limit(30),
  ]);
  return { org: org as Row | null, dossier: cur as Row | null, versions: (versions ?? []) as Row[], watch: watch as Row | null, claims: (claims ?? []) as Row[] };
}

export async function recentJobMoves(db: Db, workspaceId: string, limit = 20) {
  const { data } = await db.from("signal_claim").select("id, subject_id, value_json, observed_on, effective_on, source_url, evidence_tier, status").eq("workspace_id", workspaceId).eq("claim_type", "job_move").is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  const rows = (data ?? []) as Row[];
  const people = await nameMap(db, workspaceId, "person", rows.map((r) => r.subject_id as string));
  const orgs = await nameMap(db, workspaceId, "organisation", rows.flatMap((r) => { const v = (r.value_json ?? {}) as Row; return [v.from_org_id as string, v.to_org_id as string]; }));
  const verified = await jobMoveStates(db, workspaceId, rows.map((r) => ({ id: String(r.id), status: String(r.status) })));
  return rows.map((r): Row & { person: string; from: string | null; to: string | null; to_org_id: string | null; title: string | null; verified: boolean } => { const v = (r.value_json ?? {}) as Row; return { ...r, person: people.get(String(r.subject_id)) ?? "(restricted)", from: v.from_org_id ? orgs.get(String(v.from_org_id)) ?? "(restricted)" : null, to: v.to_org_id ? orgs.get(String(v.to_org_id)) ?? "(restricted)" : null, to_org_id: v.to_org_id as string | null, title: v.title as string | null, verified: verified.get(String(r.id)) ?? false }; });
}
