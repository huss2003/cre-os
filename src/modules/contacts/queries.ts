import type { Db } from "@/lib/supabase/server";
type Row = Record<string, any>;
const c = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;

export async function overview(db: Db, ws: string) {
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const items = () => db.from("enrichment_item").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
  const ppl = () => db.from("person").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null);
  const [total, fresh, enriched, verifiedPeople, partial, review, outdated, dups, failedJobs] = await Promise.all([
    c(ppl()), c(items().gte("created_at", week)), c(ppl().not("last_enriched_at", "is", null)),
    c(db.from("contact_method").select("person_id", { count: "exact", head: true }).eq("workspace_id", ws).eq("verify_status", "verified")),
    c(items().eq("decision", "pending").lt("completeness", 70)), c(items().eq("decision", "pending")),
    c(ppl().lte("next_review_on", new Date().toISOString().slice(0, 10))),
    c(items().eq("decision", "pending").in("match_kind", ["possible_duplicate"])),
    c(db.from("enrichment_job").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ["failed", "partial"])),
  ]);
  return { total, fresh, enriched, verifiedPeople, partial, review, outdated, dups, failedJobs };
}

/** People at a company grouped by department, with role assessment, channels and reporting lines. */
export async function companyPeople(db: Db, ws: string, orgId: string) {
  const { data } = await db.from("employment").select("title, fact_status, updated_at, person:person_id(id, full_name, do_not_contact, contact_method(id, method_type, value, verify_status, suppressed), contact_role_assessment(role_class, cre_relevance, department, reason, source, active))")
    .eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).is("archived_at", null).limit(300);
  const { data: lines } = await db.from("reporting_line").select("person_id, manager_person_id, note").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null);
  return { people: (data ?? []) as Row[], lines: (lines ?? []) as Row[] };
}
