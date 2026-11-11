/**
 * Module 13 §12 — memory quality report. Read-only checks over Module 1 records (RLS). Counts are exact (count=exact),
 * example lists are capped and say so. A failed check is reported as unavailable — never as zero (S10).
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { today as todayIso } from "../data";

export interface QualityItem { label: string; detail: string | null; href: string | null }
export interface QualityCheck { key: string; label: string; help: string; count: number | null; items: QualityItem[]; error: string | null }
export interface QualityReport { generatedAt: string; checks: QualityCheck[]; total: number; unavailable: number }

const daysAgo = (today: string, n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 864e5).toISOString();
type Res = { data: unknown; error: { message: string } | null; count?: number | null };

async function check(key: string, label: string, help: string, run: () => Promise<{ count: number; items: QualityItem[] }>): Promise<QualityCheck> {
  try { const r = await run(); return { key, label, help, count: r.count, items: r.items.slice(0, 10), error: null }; }
  catch (e) { return { key, label, help, count: null, items: [], error: e instanceof Error ? e.message : "Check failed" }; }
}
const rows = (r: Res): Row[] => { if (r.error) throw new Error(r.error.message); return (r.data ?? []) as Row[]; };
const cnt = (r: Res): number => { if (r.error) throw new Error(r.error.message); return r.count ?? 0; };

export async function qualityReport(ctx: MemCtx, opts: { today?: string } = {}): Promise<QualityReport> {
  const db = ctx.db, ws = ctx.workspaceId, today = opts.today ?? todayIso();
  const exact = { count: "exact" as const };
  const checks = await Promise.all([
    check("outdated", "Outdated information", "Active requirements not updated for 180+ days and availability observations older than 90 days.", async () => {
      const [r, a] = await Promise.all([
        db.from("requirement").select("id, title, updated_at", exact).eq("workspace_id", ws).is("archived_at", null).not("status", "in", "(closed,cancelled,lost,won,dropped)").lt("updated_at", daysAgo(today, 180)).order("updated_at").limit(10),
        db.from("availability").select("id", { ...exact, head: true }).eq("workspace_id", ws).is("archived_at", null).eq("status", "available").lt("as_of", daysAgo(today, 90).slice(0, 10)),
      ]);
      return { count: cnt(r) + cnt(a), items: rows(r).map((x) => ({ label: x.title, detail: `Requirement last updated ${String(x.updated_at).slice(0, 10)}`, href: `/requirements/${x.id}` })) };
    }),
    check("missing", "Missing information", "Live requirements with no area, budget or move-in date recorded (unknown stays unknown — ask the client).", async () => {
      const r = await db.from("requirement").select("id, title", exact).eq("workspace_id", ws).is("archived_at", null).not("status", "in", "(closed,cancelled,lost,won,dropped)")
        .or("and(area_target_sf.is.null,area_max_sf.is.null,area_min_sf.is.null),and(budget_max.is.null,budget_min.is.null),occupation_date.is.null").limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: x.title, detail: "Area, budget or move-in date unknown", href: `/requirements/${x.id}` })) };
    }),
    check("contradictory", "Contradictory information", "Captured values that conflict with an earlier value for the same field and still wait for review.", async () => {
      const r = await db.from("capture_observation").select("id, field, raw_text, capture_id", exact).eq("workspace_id", ws).is("archived_at", null).not("conflict_with", "is", null).eq("status", "pending_review").order("created_at", { ascending: false }).limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: `${String(x.field).replace(/_/g, " ")}: ${x.raw_text}`, detail: "Conflicts with an earlier value", href: x.capture_id ? `/capture/${x.capture_id}` : "/approvals" })) };
    }),
    check("assumptions", "Unsupported assumptions", "Assumptions/hypotheses and AI-inferred employment that are not confirmed by a source.", async () => {
      const [o, e] = await Promise.all([
        db.from("capture_observation").select("id, field, raw_text, capture_id", exact).eq("workspace_id", ws).is("archived_at", null).in("fact_class", ["assumption", "hypothesis"]).neq("status", "rejected").neq("verification", "user_confirmed").limit(10),
        db.from("employment").select("id, title, person_id, person:person_id(full_name)", exact).eq("workspace_id", ws).is("archived_at", null).eq("fact_status", "ai_inference").limit(10),
      ]);
      return { count: cnt(o) + cnt(e), items: [...rows(o).map((x) => ({ label: x.raw_text, detail: `Assumption (${String(x.field).replace(/_/g, " ")}) — not confirmed`, href: x.capture_id ? `/capture/${x.capture_id}` : null })),
        ...rows(e).map((x) => ({ label: `${x.person?.full_name ?? "Contact"} — ${x.title ?? "role"}`, detail: "Employment inferred by AI — not verified", href: `/people/${x.person_id}` }))] };
    }),
    check("incomplete_history", "Incomplete relationship histories", "Decision-makers on requirements with no recorded interaction.", async () => {
      const s = rows(await db.from("stakeholder").select("person_id, role, person:person_id(full_name)").eq("workspace_id", ws).is("archived_at", null).in("role", ["approver", "sponsor"]).limit(500));
      const ids = [...new Set(s.map((x) => x.person_id))];
      if (!ids.length) return { count: 0, items: [] };
      const links = rows(await db.from("interaction_link").select("entity_id").eq("workspace_id", ws).eq("entity_type", "person").in("entity_id", ids).is("archived_at", null).limit(5000));
      const has = new Set(links.map((l) => l.entity_id));
      const miss = ids.filter((id) => !has.has(id));
      return { count: miss.length, items: miss.map((id) => ({ label: s.find((x) => x.person_id === id)?.person?.full_name ?? "Contact", detail: "Decision-maker with no recorded interaction", href: `/people/${id}` })) };
    }),
    check("unverified_requirements", "Unverified requirements", "Requirements behind open deals that the client has not confirmed.", async () => {
      const o = rows(await db.from("opportunity").select("requirement_id").eq("workspace_id", ws).is("archived_at", null).or("outcome.is.null,outcome.eq.open").not("requirement_id", "is", null).limit(1000));
      const ids = [...new Set(o.map((x) => x.requirement_id))];
      if (!ids.length) return { count: 0, items: [] };
      const r = await db.from("requirement").select("id, title", exact).eq("workspace_id", ws).in("id", ids.slice(0, 300)).is("confirmed_at", null).limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: x.title, detail: "Not client-confirmed", href: `/requirements/${x.id}` })) };
    }),
    check("stale_quotes", "Stale property quotations", "Quotations past their validity, or older than 90 days without a validity date — historical, not current pricing.", async () => {
      const r = await db.from("quote").select("id, requirement_id, created_at, valid_until, space:space_id(asset:asset_id(name))", exact).eq("workspace_id", ws).is("archived_at", null).is("superseded_by", null)
        .or(`valid_until.lt.${today},and(valid_until.is.null,created_at.lt.${daysAgo(today, 90)})`).order("created_at").limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: `${x.space?.asset?.name ?? "Building"} quote ${String(x.created_at).slice(0, 10)}`, detail: x.valid_until ? `Validity ended ${x.valid_until}` : "No validity date; over 90 days old", href: x.requirement_id ? `/requirements/${x.requirement_id}` : null })) };
    }),
    check("outdated_employment", "Contacts with outdated employment", "Current-employment records older than a year that were never re-checked.", async () => {
      const r = await db.from("employment").select("id, title, created_at, person_id, person:person_id!inner(full_name, last_enriched_at)", exact).eq("workspace_id", ws).is("archived_at", null).eq("is_current", true)
        .lt("created_at", daysAgo(today, 365)).or(`last_enriched_at.is.null,last_enriched_at.lt.${daysAgo(today, 365)}`, { referencedTable: "person" }).limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: `${x.person?.full_name ?? "Contact"} — ${x.title ?? "role unknown"}`, detail: `Recorded ${String(x.created_at).slice(0, 10)}, not re-verified`, href: `/people/${x.person_id}` })) };
    }),
    check("no_source", "Records without source references", "Employment, lease and availability records with no linked source document.", async () => {
      const [e, l, a] = await Promise.all([
        db.from("employment").select("id", { ...exact, head: true }).eq("workspace_id", ws).is("archived_at", null).is("source_object_id", null),
        db.from("lease").select("id, tenant_name_raw, tenant_org_id", exact).eq("workspace_id", ws).is("archived_at", null).is("source_object_id", null).limit(10),
        db.from("availability").select("id", { ...exact, head: true }).eq("workspace_id", ws).is("archived_at", null).is("source_object_id", null),
      ]);
      return { count: cnt(e) + cnt(l) + cnt(a), items: rows(l).map((x) => ({ label: `Lease: ${x.tenant_name_raw ?? "tenant unknown"}`, detail: "No source document linked", href: x.tenant_org_id ? `/companies/${x.tenant_org_id}` : "/leases" })) };
    }),
    check("duplicates", "Duplicate observations", "Captured items that repeat the same underlying source (counted once, not as confirmation).", async () => {
      const r = await db.from("capture_observation").select("id, field, raw_text, capture_id", exact).eq("workspace_id", ws).is("archived_at", null).eq("independent", false).order("created_at", { ascending: false }).limit(10);
      return { count: cnt(r), items: rows(r).map((x) => ({ label: x.raw_text, detail: `Repeat (${String(x.field).replace(/_/g, " ")})`, href: x.capture_id ? `/capture/${x.capture_id}` : null })) };
    }),
    check("review", "Information requiring review", "Captured items pending review plus detected changes not yet acknowledged.", async () => {
      const [o, c] = await Promise.all([
        db.from("capture_observation").select("id", { ...exact, head: true }).eq("workspace_id", ws).is("archived_at", null).eq("status", "pending_review"),
        db.from("memory_change").select("id, change_kind, difference, entity_type, entity_id", exact).eq("workspace_id", ws).is("archived_at", null).eq("state", "open").order("created_at", { ascending: false }).limit(10),
      ]);
      return { count: cnt(o) + cnt(c), items: rows(c).map((x) => ({ label: x.difference?.text ?? x.change_kind, detail: String(x.change_kind).replace(/_/g, " "), href: `#c-${x.id}` })) };
    }),
  ]);
  return { generatedAt: new Date().toISOString(), checks, total: checks.reduce((n, c) => n + (c.count ?? 0), 0), unavailable: checks.filter((c) => c.error).length };
}
