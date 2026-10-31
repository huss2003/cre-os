import "server-only";
import type { Db } from "@/lib/supabase/server";
import { isoDate } from "../common";
import { detectClaimFindings, detectQuoteVsListing, detectFormerContacts, type Finding, type PatrolClaim, type QuoteLite, type AvailabilityLite, type StakeholderEmployment } from "./patrol";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Daily patrol. Works with an RLS client or the admin client (every query filters workspace_id explicitly). */
export async function runPatrol(db: Db, workspaceId: string, now = new Date()) {
  const today = isoDate(now)!;
  const [claimsRes, quotesRes, availRes, shRes, dossRes] = await Promise.all([
    db.from("signal_claim").select("id, subject_type, subject_id, claim_type, predicate, value_json, observed_on, created_at, expires_on, status").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(3000),
    db.from("quote").select("id, space_id, created_at, terms_json, superseded_by").eq("workspace_id", workspaceId).is("superseded_by", null).is("archived_at", null).limit(1000),
    db.from("availability").select("id, space_id, as_of, asking_rent_min, asking_rent_max, status, valid_until").eq("workspace_id", workspaceId).is("archived_at", null).order("as_of", { ascending: false }).limit(3000),
    db.from("stakeholder").select("id, requirement_id, person_id, employment_id").eq("workspace_id", workspaceId).is("archived_at", null).limit(2000),
    db.from("research_dossier").select("id, org_id, next_refresh_at, expired_claim_count").eq("workspace_id", workspaceId).eq("is_current", true).limit(3000),
  ]);
  for (const r of [claimsRes, quotesRes, availRes, shRes, dossRes]) if (r.error) throw r.error;

  const findings: Finding[] = [];
  findings.push(...detectClaimFindings((claimsRes.data ?? []) as PatrolClaim[], today));

  const quotes: QuoteLite[] = ((quotesRes.data ?? []) as Row[]).map((q) => {
    const t = (q.terms_json ?? {}) as Record<string, unknown>;
    return { id: String(q.id), space_id: q.space_id as string | null, created_at: String(q.created_at), rent: num(t.rent ?? t.rent_per_sf ?? t.rent_psf) };
  });
  findings.push(...detectQuoteVsListing(quotes, ((availRes.data ?? []) as Row[]).map((a) => ({ id: String(a.id), space_id: String(a.space_id), as_of: String(a.as_of), asking_rent_min: num(a.asking_rent_min), asking_rent_max: num(a.asking_rent_max), status: String(a.status), valid_until: a.valid_until as string | null })) as AvailabilityLite[], today));

  const sh = (shRes.data ?? []) as Row[];
  if (sh.length) {
    const reqIds = [...new Set(sh.map((s) => String(s.requirement_id)))];
    const personIds = [...new Set(sh.map((s) => String(s.person_id)))];
    const [reqs, emps, people] = await Promise.all([
      db.from("requirement").select("id, org_id").eq("workspace_id", workspaceId).in("id", reqIds),
      db.from("employment").select("person_id, org_id, is_current").eq("workspace_id", workspaceId).in("person_id", personIds),
      db.from("person").select("id, full_name").eq("workspace_id", workspaceId).in("id", personIds),
    ]);
    const reqOrg = new Map(((reqs.data ?? []) as Row[]).map((r) => [String(r.id), String(r.org_id)]));
    const names = new Map(((people.data ?? []) as Row[]).map((p) => [String(p.id), String(p.full_name)]));
    const rowsSE: StakeholderEmployment[] = sh.map((s) => {
      const org = reqOrg.get(String(s.requirement_id)) ?? "";
      const atOrg = ((emps.data ?? []) as Row[]).filter((e) => e.person_id === s.person_id && e.org_id === org);
      return {
        stakeholder_id: String(s.id), requirement_id: String(s.requirement_id), person_id: String(s.person_id), person_name: names.get(String(s.person_id)) ?? "A stakeholder", org_id: org,
        current_at_org: atOrg.length === 0 ? null : atOrg.some((e) => e.is_current === true),
      };
    });
    findings.push(...detectFormerContacts(rowsSE));
  }

  for (const d of (dossRes.data ?? []) as Row[]) {
    const overdue = String(d.next_refresh_at) < now.toISOString();
    if (Number(d.expired_claim_count) > 0 || overdue) {
      findings.push({ kind: "dossier_stale", subject_type: "organisation", subject_id: String(d.org_id), detail: `${overdue ? "Dossier refresh is overdue" : ""}${overdue && Number(d.expired_claim_count) > 0 ? "; " : ""}${Number(d.expired_claim_count) > 0 ? `${d.expired_claim_count} expired claim(s) in the dossier` : ""}.`, refs: [{ type: "research_dossier", id: String(d.id) }], severity: "low", dedupe_key: `stale:${d.id}` });
    }
  }

  let inserted = 0;
  for (let i = 0; i < findings.length; i += 200) {
    const batch = findings.slice(i, i + 200).map((f) => ({ workspace_id: workspaceId, kind: f.kind, subject_type: f.subject_type, subject_id: f.subject_id, detail: f.detail, refs: f.refs, severity: f.severity, dedupe_key: f.dedupe_key }));
    const { data, error } = await db.from("evidence_finding").upsert(batch, { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }).select("id");
    if (error) throw error;
    inserted += data?.length ?? 0;
  }
  return { detected: findings.length, inserted };
}
