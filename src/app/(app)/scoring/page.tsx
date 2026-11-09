import Link from "next/link";
import { Suspense } from "react";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { Loading } from "@/modules/admin/ui/parts";
import { ensureModels } from "@/modules/scoring/service";
import { BulkScore } from "@/modules/scoring/ui/bulk";
import { MODELS } from "@/modules/scoring/models";
import { ScoreBar, Completeness, CONF_LABEL } from "@/modules/scoring/ui/parts";
import type { ModelKey } from "@/modules/scoring/engine";

export const metadata = { title: "Scoring" };
type Row = Record<string, any>;
type SP = { industry?: string; geo?: string; expiry?: string; owner?: string; tab?: string; q?: string; band?: string; confidence?: string; min?: string; max?: string; complete?: string; sort?: string; req?: string };

const TABS: { key: ModelKey | "properties"; label: string }[] = [
  { key: "company", label: "Companies" }, { key: "lead", label: "Leads" }, { key: "contact", label: "Contacts" },
  { key: "requirement", label: "Requirements" }, { key: "properties", label: "Property matches" }, { key: "opportunity", label: "Opportunities" },
  { key: "relationship", label: "Relationships" },
];
const HIGH = ["Very High", "High", "Strong"];

async function names(db: Row, ws: string, type: string, ids: string[]): Promise<Map<string, { name: string; sub?: string }>> {
  if (!ids.length) return new Map();
  const m = new Map<string, { name: string; sub?: string }>();
  if (type === "organisation") for (const r of (await db.from("organisation").select("id, display_name, sector").eq("workspace_id", ws).in("id", ids)).data ?? []) m.set(r.id, { name: r.display_name, sub: r.sector ?? undefined });
  if (type === "person") for (const r of (await db.from("person").select("id, full_name, employment(title, is_current, org:org_id(display_name))").eq("workspace_id", ws).in("id", ids)).data ?? []) {
    const e = (r.employment ?? []).find((x: Row) => x.is_current); m.set(r.id, { name: r.full_name, sub: e ? `${e.title ?? ""}${e.org ? ` · ${e.org.display_name}` : ""}` : undefined });
  }
  if (type === "requirement") for (const r of (await db.from("requirement").select("id, title, org:org_id(display_name)").eq("workspace_id", ws).in("id", ids)).data ?? []) m.set(r.id, { name: r.title, sub: r.org?.display_name });
  if (type === "opportunity") for (const r of (await db.from("opportunity").select("id, name, stage, org:org_id(display_name)").eq("workspace_id", ws).in("id", ids)).data ?? []) m.set(r.id, { name: r.name, sub: `${r.org?.display_name ?? ""} · ${String(r.stage).replace(/_/g, " ")}` });
  return m;
}

/** Industry / micro-market / lease-expiry / owner filters → allowed entity ids (null = no filter). */
async function entityFilter(db: Row, ws: string, tab: ModelKey, sp: SP & { userId?: string }): Promise<Set<string> | null> {
  if (!sp.industry && !sp.geo && !sp.expiry && !sp.owner) return null;
  let orgs: Set<string> | null = null;
  const and = (ids: string[]) => { const s = new Set(ids); orgs = orgs ? new Set([...orgs].filter((x) => s.has(x))) : s; };
  if (sp.industry) and(((await db.from("organisation").select("id").eq("workspace_id", ws).ilike("sector", sp.industry)).data ?? []).map((r: Row) => r.id));
  if (sp.geo) and(((await db.from("lease").select("tenant_org_id, asset:asset_id!inner(locality_id, micro_market_id)").eq("workspace_id", ws).or(`locality_id.eq.${sp.geo},micro_market_id.eq.${sp.geo}`, { referencedTable: "asset" })).data ?? []).map((r: Row) => r.tenant_org_id).filter(Boolean));
  if (sp.expiry) {
    const to = new Date(Date.now() + Number(sp.expiry) * 30 * 86_400_000).toISOString().slice(0, 10);
    and(((await db.from("lease").select("tenant_org_id").eq("workspace_id", ws).gte("contractual_expiry", new Date().toISOString().slice(0, 10)).lte("contractual_expiry", to)).data ?? []).map((r: Row) => r.tenant_org_id).filter(Boolean));
  }
  if (sp.owner) {
    const uid = sp.owner === "me" ? (await db.auth.getUser()).data.user?.id : sp.owner;
    and(((await db.from("opportunity").select("org_id").eq("workspace_id", ws).or(`account_owner_user_id.eq.${uid},owner_user_id.eq.${uid}`)).data ?? []).map((r: Row) => r.org_id));
  }
  const o: Set<string> = orgs ?? new Set<string>();
  if (["company", "lead", "relationship"].includes(tab)) return o;
  const ids = [...o];
  if (!ids.length) return new Set();
  if (tab === "contact") return new Set(((await db.from("employment").select("person_id").eq("workspace_id", ws).eq("is_current", true).in("org_id", ids)).data ?? []).map((r: Row) => r.person_id));
  if (tab === "requirement") return new Set(((await db.from("requirement").select("id").eq("workspace_id", ws).in("org_id", ids)).data ?? []).map((r: Row) => r.id));
  if (tab === "opportunity") return new Set(((await db.from("opportunity").select("id").eq("workspace_id", ws).in("org_id", ids)).data ?? []).map((r: Row) => r.id));
  return o;
}

async function filterOptions(db: Row, ws: string) {
  const [{ data: secs }, { data: geos }, { data: mem }] = await Promise.all([
    db.from("organisation").select("sector").eq("workspace_id", ws).not("sector", "is", null).limit(2000),
    db.from("geography").select("id, name, level").eq("workspace_id", ws).in("level", ["micro_market", "locality"]).is("archived_at", null).order("name").limit(300),
    db.from("membership").select("user_id, display_name").eq("workspace_id", ws).limit(50),
  ]);
  return {
    industries: [...new Set((secs ?? []).map((r: Row) => String(r.sector).trim()).filter(Boolean))].sort().slice(0, 60) as string[],
    geos: (geos ?? []).map((g: Row) => ({ id: g.id, name: g.name })) as { id: string; name: string }[],
    owners: (mem ?? []).map((m: Row) => ({ id: m.user_id, label: m.display_name ?? "Member" })) as { id: string; label: string }[],
  };
}

async function Stats({ db, ws }: { db: Row; ws: string }) {
  const { data } = await db.from("score_result").select("model_key, band, confidence, previous_score, calculated_at").eq("workspace_id", ws).eq("is_current", true).limit(20000);
  const rows = (data ?? []) as Row[];
  const by = (k: string) => rows.filter((r) => r.model_key === k);
  const [{ count: matches }, { count: queued }] = await Promise.all([
    db.from("shortlist_option").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null),
    db.from("job").select("id", { count: "exact", head: true }).eq("workspace_id", ws).like("job_type", "scoring.%").in("state", ["queued", "running"]),
  ]);
  const week = Date.now() - 7 * 86_400_000;
  const tiles: [string, number | string][] = [
    ["Companies scored", by("company").length], ["High-priority companies", by("company").filter((r) => HIGH.includes(r.band)).length],
    ["High-priority leads", by("lead").filter((r) => HIGH.includes(r.band)).length], ["Attractive opportunities", by("opportunity").filter((r) => HIGH.includes(r.band)).length],
    ["Requirements scored", by("requirement").length], ["Property matches", matches ?? 0], ["Contacts ranked", by("contact").length],
    ["Waiting to recalculate", queued ?? 0], ["Not enough data", rows.filter((r) => r.confidence === "insufficient").length],
    ["Changed this week", rows.filter((r) => r.previous_score !== null && Date.parse(r.calculated_at) >= week).length],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-5">
      {tiles.map(([l, n]) => <div key={l} className="bg-surface p-4"><dt className="text-xs text-ink-soft">{l}</dt><dd className="mt-1 text-2xl font-bold tabular-nums">{n}</dd></div>)}
    </dl>
  );
}

async function Ranking({ sp, db, ws }: { sp: SP; db: Row; ws: string }) {
  const tab = (sp.tab ?? "company") as ModelKey;
  const entity = MODELS[tab].version && ({ company: "organisation", lead: "organisation", relationship: "organisation", contact: "person", requirement: "requirement", opportunity: "opportunity" } as const)[tab];
  let q = db.from("score_result").select("id, entity_id, score, band, confidence, completeness, recommended_action, calculated_at, previous_score, missing").eq("workspace_id", ws).eq("model_key", tab).eq("is_current", true);
  if (sp.band) q = q.eq("band", sp.band);
  if (sp.confidence) q = q.eq("confidence", sp.confidence);
  if (sp.min) q = q.gte("score", Number(sp.min));
  if (sp.max) q = q.lte("score", Number(sp.max));
  if (sp.complete) q = q.gte("completeness", Number(sp.complete));
  const sort = sp.sort ?? "high";
  q = sort === "low" ? q.order("score", { ascending: true }) : sort === "recent" ? q.order("calculated_at", { ascending: false }) : sort === "confidence" ? q.order("completeness", { ascending: false }) : q.order("score", { ascending: false });
  let rows = ((await q.limit(1000)).data ?? []) as Row[];
  const allow = await entityFilter(db, ws, tab, sp);
  if (allow) rows = rows.filter((r) => allow.has(r.entity_id));
  rows = rows.slice(0, 300);
  const nm = await names(db, ws, entity, rows.map((r) => r.entity_id));
  if (sp.q) rows = rows.filter((r) => `${nm.get(r.entity_id)?.name ?? ""} ${nm.get(r.entity_id)?.sub ?? ""}`.toLowerCase().includes(sp.q!.toLowerCase()));
  const ovs = new Map(((await db.from("score_override").select("entity_id, value").eq("workspace_id", ws).eq("model_key", tab).eq("kind", "priority").eq("active", true)).data ?? []).map((o: Row) => [o.entity_id, o.value]));
  const bands = MODELS[tab].version.bands.map((b) => b.label);
  const opts = await filterOptions(db, ws);
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">{MODELS[tab].purpose}</p>
      <form method="get" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value={tab} />
        <input name="q" defaultValue={sp.q} placeholder="Search name or company" aria-label="Search" className="min-h-10 min-w-48 flex-1 rounded-xl border border-line bg-surface px-3 text-sm" />
        <select name="band" defaultValue={sp.band ?? ""} aria-label="Priority" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Any priority</option>{bands.map((b) => <option key={b}>{b}</option>)}<option>Disqualified</option></select>
        <select name="confidence" defaultValue={sp.confidence ?? ""} aria-label="Confidence" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="insufficient">Not enough data</option></select>
        <select name="sort" defaultValue={sort} aria-label="Sort" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="high">Highest score</option><option value="low">Lowest score</option><option value="recent">Recently calculated</option><option value="confidence">Most complete</option></select>
        <details className="w-full sm:w-auto" open={!!(sp.industry || sp.geo || sp.expiry || sp.owner || sp.min || sp.max || sp.complete)}><summary className="min-h-10 cursor-pointer list-none rounded-xl border border-line px-3 py-2 text-sm">More filters</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {opts.industries.length ? <select name="industry" defaultValue={sp.industry ?? ""} aria-label="Industry" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Any industry</option>{opts.industries.map((x) => <option key={x}>{x}</option>)}</select> : null}
            {opts.geos.length ? <select name="geo" defaultValue={sp.geo ?? ""} aria-label="Micro-market" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Any micro-market</option>{opts.geos.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select> : null}
            <select name="expiry" defaultValue={sp.expiry ?? ""} aria-label="Lease expiry" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Any lease expiry</option><option value="6">Lease expiring in 6 months</option><option value="12">in 12 months</option><option value="18">in 18 months</option><option value="24">in 24 months</option></select>
            {opts.owners.length ? <select name="owner" defaultValue={sp.owner ?? ""} aria-label="Assigned to" className="min-h-10 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">Anyone</option><option value="me">Assigned to me</option>{opts.owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> : null}
            <input name="min" type="number" min={0} max={100} defaultValue={sp.min} placeholder="Min score" aria-label="Minimum score" className="min-h-10 w-28 rounded-xl border border-line bg-surface px-3 text-sm" />
            <input name="max" type="number" min={0} max={100} defaultValue={sp.max} placeholder="Max score" aria-label="Maximum score" className="min-h-10 w-28 rounded-xl border border-line bg-surface px-3 text-sm" />
            <input name="complete" type="number" min={0} max={100} defaultValue={sp.complete} placeholder="Min % known" aria-label="Minimum data completeness" className="min-h-10 w-32 rounded-xl border border-line bg-surface px-3 text-sm" />
          </div></details>
        <button className="min-h-10 rounded-xl bg-ink px-4 text-sm font-semibold text-white">Apply</button>
      </form>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">Nothing scored here yet</p><p className="mt-1 text-sm text-ink-soft">Scores appear automatically when records change, or press <b>Score everything now</b>.</p></div>
      ) : (
        <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r, i) => {
            const n = nm.get(r.entity_id); const ov = ovs.get(r.entity_id);
            return (
              <li key={r.id}>
                <Link href={`/scoring/${tab}/${r.entity_id}`} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 px-4 py-3 hover:bg-canvas sm:grid-cols-[2rem_1fr_9rem_7rem]">
                  <span className="text-sm tabular-nums text-ink-soft">{i + 1}</span>
                  <span className="min-w-0"><span className="block truncate font-medium">{n?.name ?? "Deleted record"}</span><span className="block truncate text-xs text-ink-soft">{n?.sub ?? ""}{r.recommended_action ? `${n?.sub ? " — " : ""}${r.recommended_action}` : ""}</span></span>
                  <span className="hidden flex-col gap-1 sm:flex"><ScoreBar score={r.score} band={r.band} /><span className="text-xs text-ink-soft">{CONF_LABEL[r.confidence]} · <Completeness value={r.completeness} /></span></span>
                  <span className="text-right"><span className="text-xl font-bold tabular-nums">{r.score}</span><span className="block text-xs text-ink-soft">{ov ? <><s>{r.band}</s> {ov}</> : r.band}</span></span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

async function Properties({ sp, db, ws }: { sp: SP; db: Row; ws: string }) {
  const { data: reqs } = await db.from("requirement").select("id, title, org:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null).neq("status", "closed").order("updated_at", { ascending: false }).limit(100);
  const reqId = sp.req ?? reqs?.[0]?.id;
  const opts = reqId ? ((await db.from("shortlist_option").select("id, eligible, disqualifiers, fit_score, completeness_score, score_breakdown, rubric_version, asset:asset_id(name), space:space_id(floor_text, unit)").eq("workspace_id", ws).eq("requirement_id", reqId).is("archived_at", null).order("eligible", { ascending: false }).order("fit_score", { ascending: false }).limit(50)).data ?? []) as Row[] : [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">Property suitability is scored per requirement by the matching engine: must-haves are checked first, then weighted fit. A building that fails a must-have never ranks above one that passes.</p>
      {!reqs?.length ? <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-ink-soft">Add a requirement to match properties against it.</div> : (
        <>
          <form method="get" className="flex gap-2"><input type="hidden" name="tab" value="properties" />
            <select name="req" defaultValue={reqId} aria-label="Requirement" className="min-h-10 flex-1 rounded-xl border border-line bg-surface px-3 text-sm">{reqs.map((r: Row) => <option key={r.id} value={r.id}>{r.title}{r.org ? ` — ${r.org.display_name}` : ""}</option>)}</select>
            <button className="min-h-10 rounded-xl bg-ink px-4 text-sm font-semibold text-white">Show</button></form>
          {opts.length === 0 ? <div className="rounded-2xl border border-dashed border-line px-6 py-8 text-center text-sm">No matches yet. <Link className="font-semibold text-brand underline" href={`/requirements/${reqId}`}>Open the requirement and run matching</Link>.</div> : (
            <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {opts.map((o, i) => (
                <li key={o.id} className="grid grid-cols-[2rem_1fr_auto] items-start gap-3 px-4 py-3">
                  <span className="text-sm text-ink-soft">{i + 1}</span>
                  <span className="min-w-0"><span className="block font-medium">{o.asset?.name ?? "Building"}{o.space ? ` — ${[o.space.floor_text, o.space.unit].filter(Boolean).join(" ")}` : ""}</span>
                    <span className="block text-xs text-ink-soft">{o.eligible ? `Data ${Math.round(Number(o.completeness_score ?? 0))}% complete` : `Fails: ${(o.disqualifiers ?? []).join(", ")}`}</span></span>
                  <span className="text-right">{o.eligible ? <><span className="text-xl font-bold tabular-nums">{Math.round(Number(o.fit_score ?? 0))}</span><span className="block text-xs text-ink-soft">match %</span></> : <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">Disqualified</span>}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext("viewer");
  await ensureModels(ctx.db, ctx.workspaceId);
  const tab = sp.tab ?? "company";
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0"><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Scoring</h1><p className="mt-1 max-w-xl text-ink-soft">Who to focus on first, and why. Every score shows its reasons, sources, how much is known and how sure it is.</p></div>
        {hasRole(ctx, "admin") ? (
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start">
            <Link href="/scoring/models" className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-xl border border-line bg-surface px-4 text-sm font-semibold">Scoring rules</Link>
            <BulkScore />
          </div>
        ) : null}
      </header>
      <Suspense fallback={<div className="h-40 rounded-2xl bg-surface" />}><Stats db={ctx.db} ws={ctx.workspaceId} /></Suspense>
      <nav aria-label="Score type" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line pb-px">
        {TABS.map((t) => <Link key={t.key} href={`/scoring?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-ink font-semibold" : "border-transparent text-ink-soft hover:text-ink"}`}>{t.label}</Link>)}
      </nav>
      {tab === "properties" ? <Properties sp={sp} db={ctx.db} ws={ctx.workspaceId} /> : <Ranking sp={sp} db={ctx.db} ws={ctx.workspaceId} />}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense>;
}
