import Link from "next/link";
import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { KIND_LABEL } from "@/modules/toolkit/deliverables";

type Row = Record<string, any>;
const SECTIONS: { n: string; title: string; blurb: string; links: { href: string; label?: string }[]; kinds: string[] }[] = [
  { n: "01", title: "Requirement brief", blurb: "What the client needs — each item marked confirmed, estimated, assumed or missing.", links: [{ href: "/toolkit/brief" }], kinds: ["brief"] },
  { n: "02", title: "Property comparison", blurb: "Rate shortlisted buildings side by side on weighted criteria.", links: [{ href: "/toolkit/compare" }], kinds: ["property_comparison"] },
  { n: "03", title: "Lease economics", blurb: "Rent, escalation, rent-free and deposit over the full term.", links: [{ href: "/toolkit/lease" }], kinds: ["lease_economics"] },
  { n: "04", title: "Occupancy economics", blurb: "Total cost per seat and per square foot, all-in.", links: [{ href: "/toolkit/occupancy" }], kinds: ["occupancy"] },
  { n: "05", title: "Conventional vs managed", blurb: "A leased office against a managed or flex office.", links: [{ href: "/toolkit/managed" }], kinds: ["conventional_vs_managed"] },
  { n: "06", title: "Renewal vs relocation", blurb: "Stay and renegotiate, or move — costs and disruption.", links: [{ href: "/toolkit/renewal" }], kinds: ["renewal_vs_relocation"] },
  { n: "07", title: "Fit-out & financing", blurb: "Fit-out budget, then how to fund it.", links: [{ href: "/toolkit/fitout", label: "Fit-out" }, { href: "/toolkit/financing", label: "Financing" }], kinds: ["fitout", "financing"] },
  { n: "08", title: "Negotiation", blurb: "Positions, concessions and walk-away points.", links: [{ href: "/toolkit/negotiation" }], kinds: ["negotiation"] },
  { n: "09", title: "Client deliverables", blurb: "Proposal, workbook and decision summary from saved analyses.", links: [{ href: "/toolkit/deliverables" }], kinds: ["deliverable"] },
  { n: "10", title: "Specialist models", blurb: "Further models for particular deal types.", links: [{ href: "/toolkit/models" }], kinds: [] },
  { n: "11", title: "Quotes & evidence", blurb: "Upload a quote; AI reads the terms; every version kept.", links: [{ href: "/toolkit/quotes" }], kinds: [] },
  { n: "12", title: "Visit packs & decks", blurb: "Site-visit pack and presentation deck for a shortlist.", links: [{ href: "/toolkit/packs" }], kinds: [] },
];
const hrefFor = (kind: string) => SECTIONS.find((s) => s.kinds.includes(kind))?.links[0].href ?? "/toolkit";
const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime();

function Heading({ children }: { children: string }) {
  return <h2 className="flex items-center border-b border-ink pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink">{children}<HelpFor k={children} /></h2>;
}

export default async function ToolkitPage() {
  const app = await requirePageContext();
  const db = app.db, ws = app.workspaceId;
  const today = new Date().toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const [all, recent, reqs, quotes] = await Promise.all([
    db.from("deal_analysis").select("kind, status, requirement_id").eq("workspace_id", ws).is("archived_at", null).limit(5000),
    db.from("deal_analysis").select("id, kind, title, status, current_version, missing, updated_at, requirement_id").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(40),
    db.from("requirement").select("id, title, status, updated_at, organisation:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(300),
    db.from("quote").select("id, version, valid_until, requirement_id, terms_json, counterparty:counterparty_org_id(display_name), requirement:requirement_id(title)").eq("workspace_id", ws).is("archived_at", null).is("superseded_by", null).not("valid_until", "is", null).lte("valid_until", in14).order("valid_until").limit(100),
  ]);
  const rows = (all.data ?? []) as Row[];
  const count: Record<string, number> = {};
  for (const r of rows) count[r.kind] = (count[r.kind] ?? 0) + 1;
  const analysed = new Set(rows.map((r) => r.requirement_id).filter(Boolean));
  const recentRows = ((recent.data ?? []) as Row[]).slice(0, 8);
  const needsInfo = ((recent.data ?? []) as Row[]).filter((r) => r.status === "needs_info").slice(0, 8);
  const awaiting = ((reqs.data ?? []) as Row[]).filter((r) => !analysed.has(r.id)).slice(0, 8);
  const q = (quotes.data ?? []) as Row[];
  const expired = q.filter((x) => x.valid_until < today);
  const expiring = q.filter((x) => x.valid_until >= today);

  return (
    <div className="mx-auto max-w-5xl space-y-12 pb-16">
      <header className="pt-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Deal toolkit</p>
        <h1 className="mt-2 font-serif text-3xl leading-tight text-ink sm:text-4xl">Compare, cost and recommend.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">Every analysis is saved with its inputs and formula version, so any number in a client document can be traced and reproduced. Start from a requirement brief; finish with a client deliverable.</p>
      </header>

      {expired.length > 0 && (
        <section className="border-l-4 border-bad bg-bad/5 px-4 py-3" aria-label="Expired quotes">
          <p className="text-sm font-semibold text-bad">{expired.length} quote{expired.length === 1 ? " has" : "s have"} expired — figures built on {expired.length === 1 ? "it" : "them"} are out of date.</p>
          <ul className="mt-2 space-y-1 text-sm">
            {expired.map((x) => <li key={x.id}><Link className="underline decoration-bad/40 underline-offset-2 hover:text-bad" href={x.requirement_id ? `/requirements/${x.requirement_id}` : "/deals"}>{x.counterparty?.display_name ?? "Quote"} v{x.version}</Link> <span className="text-ink-soft">· {x.requirement?.title ?? "no requirement"} · expired {x.valid_until}</span></li>)}
          </ul>
        </section>
      )}

      <section>
        <Heading>Toolkit sections</Heading>
        <ol className="divide-y divide-line">
          {SECTIONS.map((s) => {
            const n = s.kinds.reduce((a, k) => a + (count[k] ?? 0), 0);
            return (
              <li key={s.n} className="grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-3 py-4">
                <span className="font-mono text-xs text-ink-soft">{s.n}</span>
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    {s.links.length === 1
                      ? <Link href={s.links[0].href} className="text-lg font-medium text-ink hover:text-brand">{s.title}</Link>
                      : <span className="text-lg font-medium text-ink">{s.title}</span>}
                    {s.links.length > 1 && s.links.map((l) => <Link key={l.href} href={l.href} className="text-sm text-brand underline-offset-2 hover:underline">{l.label} →</Link>)}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-soft">{s.blurb}</p>
                </div>
                <span className="text-right text-sm tabular-nums text-ink-soft">{s.kinds.length ? <><span className="text-base font-semibold text-ink">{n}</span> saved</> : null}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-12 md:grid-cols-2">
        <section>
          <Heading>Recently updated</Heading>
          {recentRows.length === 0 ? <p className="py-4 text-sm text-ink-soft">No analyses yet. Open a requirement brief and save a snapshot to start.</p> : (
            <ul className="divide-y divide-line">{recentRows.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <Link href={r.kind === "brief" && r.requirement_id ? `/toolkit/brief/${r.requirement_id}` : hrefFor(r.kind)} className="font-medium text-ink hover:text-brand">{r.title}</Link>
                <p className="text-xs text-ink-soft">{KIND_LABEL[r.kind] ?? r.kind} · v{r.current_version} · {String(r.status).replace(/_/g, " ")} · {String(r.updated_at).slice(0, 10)}</p>
              </li>))}</ul>
          )}
        </section>
        <section>
          <Heading>Needs information</Heading>
          {needsInfo.length === 0 ? <p className="py-4 text-sm text-ink-soft">Nothing is waiting on information.</p> : (
            <ul className="divide-y divide-line">{needsInfo.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <Link href={hrefFor(r.kind)} className="font-medium text-ink hover:text-brand">{r.title}</Link>
                <p className="text-xs text-warn">Missing: {((r.missing ?? []) as string[]).slice(0, 5).join(", ") || "—"}{(r.missing ?? []).length > 5 ? ` +${r.missing.length - 5} more` : ""}</p>
              </li>))}</ul>
          )}
        </section>
        <section>
          <Heading>Requirements awaiting analysis</Heading>
          {awaiting.length === 0 ? <p className="py-4 text-sm text-ink-soft">{(reqs.data ?? []).length ? "Every requirement has at least one analysis." : "No requirements yet — create one under Deals → Requirements."}</p> : (
            <ul className="divide-y divide-line">{awaiting.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 py-3 text-sm">
                <span><span className="font-medium text-ink">{r.title}</span><span className="block text-xs text-ink-soft">{r.organisation?.display_name ?? "—"} · {String(r.status).replace(/_/g, " ")}</span></span>
                <Link href={`/toolkit/brief/${r.id}`} className="shrink-0 text-brand hover:underline">Build brief →</Link>
              </li>))}</ul>
          )}
        </section>
        <section>
          <Heading>Quotes expiring soon</Heading>
          {expiring.length === 0 ? <p className="py-4 text-sm text-ink-soft">No quotes expire in the next 14 days.</p> : (
            <ul className="divide-y divide-line">{expiring.map((x) => {
              const days = Math.round((day(x.valid_until) - day(today)) / 864e5);
              return (
                <li key={x.id} className="flex items-baseline justify-between gap-3 py-3 text-sm">
                  <span><Link href={x.requirement_id ? `/requirements/${x.requirement_id}` : "/deals"} className="font-medium text-ink hover:text-brand">{x.counterparty?.display_name ?? "Quote"} v{x.version}</Link><span className="block text-xs text-ink-soft">{x.requirement?.title ?? "no requirement"}</span></span>
                  <span className={`shrink-0 tabular-nums ${days <= 3 ? "font-semibold text-warn" : "text-ink-soft"}`}>{days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`}</span>
                </li>);
            })}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
