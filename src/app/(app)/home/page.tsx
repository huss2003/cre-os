import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { inFocusMenu } from "@/lib/nav";
import { atLocal, fmt, localDate } from "@/lib/util/time";
import { SectionIcon } from "../nav-links";

export const metadata = { title: "Home · CRE OS" };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rows = any[] | null;
/** Run a query; on any error return null so that block simply does not show. */
async function safe(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Rows> {
  try { const r = await q; return r.error ? null : ((r.data as any[]) ?? []); } catch { return null; }
}
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

const KIND_HREF: Record<string, string> = {
  property_comparison: "/toolkit/compare", lease_economics: "/toolkit/lease", occupancy: "/toolkit/occupancy",
  renewal_vs_relocation: "/toolkit/renewal", conventional_vs_managed: "/toolkit/managed", negotiation: "/toolkit/negotiation",
  fitout: "/toolkit/fitout", financing: "/toolkit/financing", deliverable: "/toolkit/deliverables", brief: "/toolkit/brief",
};
const KIND_LABEL: Record<string, string> = {
  property_comparison: "Building comparison", lease_economics: "Lease cost", occupancy: "Cost per seat", renewal_vs_relocation: "Stay or move",
  conventional_vs_managed: "Lease vs managed", negotiation: "Negotiation plan", fitout: "Fit-out budget", financing: "Financing",
  deliverable: "Client document", brief: "Client brief",
};

const MODULES: { key: string; href: string; title: string; text: string; cta: string }[] = [
  { key: "companies", href: "/companies", title: "Records", text: "Companies, people, buildings, requirements and deals — your database.", cta: "Open records" },
  { key: "signals", href: "/signals", title: "Signals & research", text: "News and events that may mean a company needs space.", cta: "See signals" },
  { key: "scoring", href: "/scoring", title: "Scoring", text: "A 0–100 score showing who is worth your time first.", cta: "See scores" },
  { key: "contacts", href: "/contacts", title: "Contacts", text: "Find and check the right decision-maker at each company.", cta: "Find contacts" },
  { key: "outreach", href: "/outreach", title: "Outreach", text: "Who to contact today, and a ready-to-edit message.", cta: "Plan outreach" },
  { key: "meetings", href: "/meetings", title: "Meetings", text: "A one-page brief and checklist before every meeting.", cta: "Prepare a meeting" },
  { key: "toolkit", href: "/toolkit", title: "Deal toolkit", text: "Compare buildings, cost a lease, and make client documents.", cta: "Open toolkit" },
  { key: "tutorials", href: "/tutorials", title: "Tutorials", text: "Short guided walk-throughs of each screen.", cta: "Start a tutorial" },
];

function greeting(tz: string) {
  const h = Number(fmt(new Date(), "H", tz));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function HomePage() {
  const ctx = await requirePageContext();
  const ws = ctx.workspaceId;
  const tz = ctx.timezone || "Asia/Kolkata";
  const today = localDate(new Date(), tz);
  const start = atLocal(today, "00:00", tz);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const show = (href: string) => inFocusMenu(href);

  const [meetings, followUps, review, analyses, outreach] = await Promise.all([
    show("/meetings") ? safe(ctx.db.from("meeting_prep").select("id, status, readiness, meeting:meeting_visit_id!inner(title, start_at, location), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).gte("meeting.start_at", start.toISOString()).lt("meeting.start_at", end.toISOString()).limit(20)) : null,
    show("/outreach") ? safe(ctx.db.from("outreach_item").select("id, planned_on, reason, person:person_id(full_name), org:org_id(display_name)")
      .eq("workspace_id", ws).eq("status", "planned").lte("planned_on", today).is("archived_at", null).order("planned_on").limit(5)) : null,
    show("/approvals") ? safe(ctx.db.from("change_proposal").select("id").eq("workspace_id", ws).eq("state", "proposed").is("archived_at", null).limit(100)) : null,
    show("/toolkit") ? safe(ctx.db.from("deal_analysis").select("id, kind, title, requirement_id, updated_at").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(4)) : null,
    show("/outreach") ? safe(ctx.db.from("outreach_item").select("id, status, updated_at, person:person_id(full_name), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(4)) : null,
  ]);

  const meetingRows = (meetings ?? []).map((r) => ({ ...r, meeting: one<any>(r.meeting), org: one<any>(r.org) }))
    .sort((a, b) => String(a.meeting?.start_at).localeCompare(String(b.meeting?.start_at)));
  const recent = [
    ...(analyses ?? []).map((r) => ({
      id: `a-${r.id}`, at: String(r.updated_at), title: r.title || KIND_LABEL[r.kind] || "Saved analysis", meta: `Deal toolkit · ${KIND_LABEL[r.kind] ?? r.kind}`,
      href: r.kind === "brief" && r.requirement_id ? `/toolkit/brief/${r.requirement_id}` : KIND_HREF[r.kind] ?? "/toolkit", icon: "toolkit",
    })),
    ...(outreach ?? []).map((r) => ({
      id: `o-${r.id}`, at: String(r.updated_at), title: one<any>(r.person)?.full_name ?? "Outreach", icon: "outreach", href: `/outreach/${r.id}`,
      meta: `Outreach · ${String(r.status).replace(/_/g, " ")}${one<any>(r.org)?.display_name ? ` · ${one<any>(r.org).display_name}` : ""}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  const editor = hasRole(ctx, "editor");
  const blocks = [
    meetings !== null && {
      key: "meetings", label: "Meetings today", n: meetingRows.length, href: "/meetings",
      empty: "No meetings today. Add one to get a prep brief.", emptyHref: editor ? "/meetings/new" : "/meetings", emptyCta: "New meeting",
      rows: meetingRows.slice(0, 3).map((r) => ({ id: r.id, href: `/meetings/${r.id}`, title: r.meeting?.title ?? "Meeting", meta: `${fmt(r.meeting?.start_at, "HH:mm", tz)}${r.org?.display_name ? ` · ${r.org.display_name}` : ""}` })),
    },
    followUps !== null && {
      key: "outreach", label: "Follow-ups due", n: followUps.length, href: "/outreach",
      empty: "Nothing due. Plan outreach to someone new.", emptyHref: "/outreach", emptyCta: "Plan outreach",
      rows: followUps.slice(0, 3).map((r) => ({ id: r.id, href: `/outreach/${r.id}`, title: one<any>(r.person)?.full_name ?? "Contact", meta: `${r.planned_on < today ? "Overdue" : "Due today"}${one<any>(r.org)?.display_name ? ` · ${one<any>(r.org).display_name}` : ""}` })),
    },
    review !== null && {
      key: "review", label: "Waiting for review", n: review.length, href: "/approvals",
      empty: "All clear. Changes from captures and imports appear here for you to check.", emptyHref: "/capture", emptyCta: "Capture a note",
      rows: [],
    },
  ].filter(Boolean) as { key: string; label: string; n: number; href: string; empty: string; emptyHref: string; emptyCta: string; rows: { id: string; href: string; title: string; meta: string }[] }[];

  const modules = MODULES.filter((m) => show(m.href));

  return (
    <div className="space-y-10">
      <header>
        <p className="text-sm font-medium text-ink-soft">{fmt(new Date(), "EEEE, d MMMM", tz)}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{greeting(tz)}</h1>
        <p className="mt-1 text-ink-soft">Workspace: <span className="font-medium text-ink">{ctx.workspaceName || "—"}</span></p>
      </header>

      {blocks.length ? (
        <section aria-labelledby="today-h">
          <h2 id="today-h" className="mb-3 text-lg font-semibold">Today</h2>
          <div className="grid divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-3 md:divide-x md:divide-y-0">
            {blocks.map((b) => (
              <div key={b.key} className="flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><SectionIcon k={b.key} className="h-5 w-5" /></span>
                  <div className="min-w-0">
                    <p className="text-3xl font-bold leading-none tabular-nums">{b.n}{b.key === "review" && b.n >= 100 ? "+" : ""}</p>
                    <p className="mt-1 text-sm text-ink-soft">{b.label}</p>
                  </div>
                </div>
                {b.n === 0 ? (
                  <p className="mt-4 text-sm text-ink-soft">{b.empty} <Link href={b.emptyHref} className="font-medium text-brand underline decoration-brand/30 underline-offset-4">{b.emptyCta}</Link></p>
                ) : (
                  <>
                    {b.rows.length ? (
                      <ul className="mt-4 space-y-1">
                        {b.rows.map((r) => (
                          <li key={r.id}><Link href={r.href} className="-mx-2 flex min-h-11 flex-col justify-center rounded-lg px-2 py-1 hover:bg-canvas">
                            <span className="truncate text-sm font-medium">{r.title}</span><span className="truncate text-xs text-ink-soft">{r.meta}</span>
                          </Link></li>
                        ))}
                      </ul>
                    ) : null}
                    <Link href={b.href} className="mt-auto inline-flex min-h-11 items-center pt-3 text-sm font-semibold text-brand hover:underline">
                      {b.key === "review" ? "Review now" : "See all"} →
                    </Link>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {analyses !== null || outreach !== null ? (
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="mb-3 text-lg font-semibold">Pick up where you left off</h2>
          {recent.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className="group flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-canvas">
                    <SectionIcon k={r.icon} className="h-5 w-5 shrink-0 text-ink-soft" />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium group-hover:text-brand">{r.title}</span><span className="block truncate text-sm text-ink-soft">{r.meta}</span></span>
                    <span className="hidden shrink-0 text-xs text-ink-soft sm:block">{fmt(r.at, "d MMM", tz)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-2xl border border-dashed border-line bg-surface p-5 text-sm text-ink-soft">
              Nothing saved yet. Start by <Link href="/outreach/new" className="font-medium text-brand underline underline-offset-4">planning an outreach</Link> or{" "}
              <Link href="/toolkit/compare/new" className="font-medium text-brand underline underline-offset-4">comparing buildings</Link> — your recent work will show up here.
            </div>
          )}
        </section>
      ) : null}

      <section aria-labelledby="modules-h">
        <h2 id="modules-h" className="mb-1 text-lg font-semibold">Everything in CRE OS</h2>
        <p className="mb-4 text-sm text-ink-soft">Each area does one job. New here? Try <Link href="/tutorials" className="font-medium text-brand underline underline-offset-4">a tutorial</Link>.</p>
        <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {modules.map((m) => (
            <li key={m.key}>
              <Link href={m.href} className="group -mx-3 flex items-start gap-4 rounded-xl px-3 py-3 hover:bg-surface">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft group-hover:border-brand/40 group-hover:text-brand">
                  <SectionIcon k={m.key === "companies" ? "database" : m.key} className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold group-hover:text-brand">{m.title}</span>
                  <span className="block text-sm text-ink-soft">{m.text}</span>
                  <span className="mt-1 block text-sm font-medium text-brand">{m.cta} →</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
