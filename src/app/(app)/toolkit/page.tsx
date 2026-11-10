import Link from "next/link";
import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { KIND_LABEL } from "@/modules/toolkit/deliverables";
import { EmptyState, OpenRow, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";

type Row = Record<string, any>;

/** "What do you want to do?" — plain-language tasks, each with one clear button. */
const TASKS: { title: string; blurb: string; href: string; cta: string; kinds: string[]; extra?: { href: string; label: string } }[] = [
  { title: "Write down what the client needs", blurb: "Size, location, budget and dates — each marked confirmed, estimated or missing.", href: "/toolkit/brief", cta: "Open briefs", kinds: ["brief"] },
  { title: "Compare buildings", blurb: "Score shortlisted buildings side by side against the client's needs.", href: "/toolkit/compare", cta: "Compare buildings", kinds: ["property_comparison"] },
  { title: "Work out the true cost of a lease", blurb: "Rent, escalation, rent-free and deposit over the full term.", href: "/toolkit/lease", cta: "Cost a lease", kinds: ["lease_economics"] },
  { title: "Cost per seat, all-in", blurb: "Total occupancy cost per seat and per square foot.", href: "/toolkit/occupancy", cta: "Cost per seat", kinds: ["occupancy"] },
  { title: "Stay or move?", blurb: "Renew and renegotiate, or relocate — costs and disruption.", href: "/toolkit/renewal", cta: "Stay or move", kinds: ["renewal_vs_relocation"] },
  { title: "Lease vs managed office", blurb: "A conventional lease against a managed or flex office.", href: "/toolkit/managed", cta: "Compare options", kinds: ["conventional_vs_managed"] },
  { title: "Compare landlord offers", blurb: "Upload a quote; terms are read for you to check. Every version is kept.", href: "/toolkit/quotes", cta: "Add a quote", kinds: [] },
  { title: "Plan the negotiation", blurb: "Positions, concessions and walk-away points.", href: "/toolkit/negotiation", cta: "Plan negotiation", kinds: ["negotiation"] },
  { title: "Fit-out & loan", blurb: "Budget the fit-out, then decide how to pay for it.", href: "/toolkit/fitout", cta: "Fit-out budget", kinds: ["fitout", "financing"], extra: { href: "/toolkit/financing", label: "Financing" } },
  { title: "Make a client document", blurb: "Proposal, workbook and decision summary from saved work.", href: "/toolkit/deliverables", cta: "Make documents", kinds: ["deliverable"] },
  { title: "Site-visit pack & deck", blurb: "A visit pack and a presentation for a shortlist.", href: "/toolkit/packs", cta: "Make a pack", kinds: [] },
  { title: "Specialist models", blurb: "Further models for particular deal types.", href: "/toolkit/models", cta: "See models", kinds: [] },
];
const hrefFor = (kind: string) => TASKS.find((s) => s.kinds.includes(kind))?.href ?? "/toolkit";
const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime();

function Heading({ children, count }: { children: string; count?: number }) {
  return <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">{children}<HelpFor k={children} />{count !== undefined ? <span className="text-sm font-normal text-ink-soft">({count})</span> : null}</h2>;
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
  const quoteHref = (x: Row) => (x.requirement_id ? `/requirements/${x.requirement_id}` : "/deals");
  const linkFor = (r: Row) => (r.kind === "brief" && r.requirement_id ? `/toolkit/brief/${r.requirement_id}` : hrefFor(r.kind));

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-16">
      <div data-tour="toolkit-header">
        <ToolHeader back={null} eyebrow="Deal toolkit" title="What do you want to do?"
          purpose="Pick a task below. Everything you save keeps its inputs, so any number in a client document can be traced back."
          steps={["Write the client brief", "Run the numbers", "Check & approve", "Make the client document"]}
          action={<Link href="/toolkit/brief" className={btn.primary}>Start with a brief →</Link>} />
      </div>

      {(expired.length > 0 || expiring.length > 0) && (
        <section role="alert" aria-label="Quotes needing attention" className="space-y-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm">
          {expired.length > 0 && (
            <div>
              <p className="font-semibold text-rose-800">✕ {expired.length} quote{expired.length === 1 ? " has" : "s have"} expired — figures built on {expired.length === 1 ? "it are" : "them are"} out of date. Ask for a fresh quote.</p>
              <ul className="mt-2 space-y-2">{expired.map((x) => (
                <li key={x.id}><OpenRow href={quoteHref(x)} title={`${x.counterparty?.display_name ?? "Quote"} · version ${x.version}`} meta={`${x.requirement?.title ?? "No requirement"} · expired ${x.valid_until}`} right={<Status s="expired" />} /></li>))}</ul>
            </div>
          )}
          {expiring.length > 0 && (
            <div>
              <p className="font-semibold text-amber-900">◷ {expiring.length} quote{expiring.length === 1 ? "" : "s"} expire{expiring.length === 1 ? "s" : ""} in the next 14 days</p>
              <ul className="mt-2 space-y-2">{expiring.map((x) => {
                const days = Math.round((day(x.valid_until) - day(today)) / 864e5);
                return <li key={x.id}><OpenRow href={quoteHref(x)} title={`${x.counterparty?.display_name ?? "Quote"} · version ${x.version}`} meta={x.requirement?.title ?? "No requirement"} right={<Status s="pending" label={days === 0 ? "Expires today" : `${days} day${days === 1 ? "" : "s"} left`} />} /></li>;
              })}</ul>
            </div>
          )}
        </section>
      )}

      <section data-tour="toolkit-sections" aria-labelledby="start-here" className="space-y-4">
        <h2 id="start-here" className="text-lg font-semibold text-ink">Start here</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TASKS.map((s) => {
            const n = s.kinds.reduce((a, k) => a + (count[k] ?? 0), 0);
            return (
              <li key={s.href} className="flex flex-col rounded-xl border border-line bg-surface p-4">
                <p className="font-semibold text-ink">{s.title}</p>
                <p className="mt-1 flex-1 text-sm text-ink-soft">{s.blurb}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link href={s.href} className={btn.secondary}>{s.cta} →</Link>
                  {s.extra ? <Link href={s.extra.href} className={btn.secondary}>{s.extra.label} →</Link> : null}
                  {s.kinds.length ? <span className="ml-auto text-xs text-ink-soft">{n} saved</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section data-tour="toolkit-needs-info" className="space-y-3">
        <Heading count={needsInfo.length}>Needs information</Heading>
        {needsInfo.length === 0 ? <p className="text-sm text-ink-soft">Nothing is waiting on information.</p> : (
          <ul className="space-y-2">{needsInfo.map((r) => {
            const m = (r.missing ?? []) as string[];
            return <li key={r.id}><OpenRow href={linkFor(r)} title={r.title} meta={`Missing: ${m.slice(0, 5).join(", ") || "—"}${m.length > 5 ? ` +${m.length - 5} more` : ""}`} right={<Status s="needs_info" />} /></li>;
          })}</ul>
        )}
      </section>

      <div className="grid gap-10 md:grid-cols-2">
        <section className="space-y-3">
          <Heading count={awaiting.length}>Requirements awaiting analysis</Heading>
          {awaiting.length === 0 ? (
            (reqs.data ?? []).length ? <p className="text-sm text-ink-soft">Every requirement has at least one analysis.</p>
              : <EmptyState title="No requirements yet" text="A requirement is one client search. Create one first, then come back to build its brief." action={<Link href="/requirements" className={btn.primary}>Create a requirement</Link>} />
          ) : (
            <ul className="space-y-2">{awaiting.map((r) => (
              <li key={r.id}><OpenRow href={`/toolkit/brief/${r.id}`} title={r.title} meta={`${r.organisation?.display_name ?? "No company"} · build the brief`} right={<Status s="draft" label="No analysis" />} /></li>))}</ul>
          )}
        </section>
        <section className="space-y-3">
          <Heading>Recently updated</Heading>
          {recentRows.length === 0 ? <EmptyState title="No saved work yet" text="Open a requirement brief and save a snapshot to start." action={<Link href="/toolkit/brief" className={btn.primary}>Open briefs</Link>} /> : (
            <ul className="space-y-2">{recentRows.map((r) => (
              <li key={r.id}><OpenRow href={linkFor(r)} title={r.title} meta={`${KIND_LABEL[r.kind] ?? r.kind} · version ${r.current_version} · ${String(r.updated_at).slice(0, 10)}`} right={<Status s={String(r.status)} />} /></li>))}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
