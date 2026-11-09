import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { assessAction } from "@/modules/signals/actions";
import type { Assessment, Point } from "@/modules/signals/assess";

export const metadata = { title: "Client potential" };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const BAND: Record<string, { ring: string; text: string; bg: string }> = {
  Strong: { ring: "#059669", text: "text-emerald-700", bg: "bg-emerald-50" },
  Promising: { ring: "#d97706", text: "text-amber-700", bg: "bg-amber-50" },
  Weak: { ring: "#94a3b8", text: "text-slate-600", bg: "bg-slate-50" },
};

/** Score as a ring: the one bold element on the page. */
function Dial({ score, band }: { score: number; band: string }) {
  const r = 52, c = 2 * Math.PI * r, b = BAND[band] ?? BAND.Weak;
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`Score ${score} out of 100, ${band}`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeWidth="10" className="text-line" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={b.ring} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold tabular-nums leading-none">{score}</span>
        <span className="mt-1 text-xs text-ink-soft">out of 100</span>
      </div>
    </div>
  );
}

function PointRow({ p }: { p: Point }) {
  const pos = p.points > 0;
  return (
    <li className="flex gap-4 py-4">
      <span className={`w-12 shrink-0 text-right text-lg font-bold tabular-nums ${pos ? "text-emerald-700" : "text-rose-700"}`}>{pos ? "+" : ""}{p.points}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{p.label}</p>
        <p className="mt-0.5 text-sm">{p.text}</p>
        {p.source ? (
          <a href={p.source.url} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-canvas px-2 py-0.5 text-xs hover:text-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`https://www.google.com/s2/favicons?domain=${host(p.source.url)}&sz=32`} alt="" width={12} height={12} className="rounded-sm" />
            {p.source.name || host(p.source.url)}{p.source.date ? `, ${p.source.date}` : ", undated"}
          </a>
        ) : <span className="mt-1.5 inline-block rounded-full bg-canvas px-2 py-0.5 text-xs text-ink-soft">From your records</span>}
      </div>
    </li>
  );
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const { data: run } = await ctx.db.from("research_run").select("id, status, error, assessment, sources, queries, created_at").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!run?.assessment) notFound();
  const a = run.assessment as Assessment;
  const b = BAND[a.band] ?? BAND.Weak;
  const sources = (run.sources ?? []) as { url: string; title: string; used: boolean }[];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/research" className="text-sm text-ink-soft hover:text-ink">Research</Link>
      <header className="flex flex-col gap-6 rounded-2xl border border-line bg-surface p-6 sm:flex-row sm:items-center">
        <Dial score={a.score} band={a.band} />
        <div className="min-w-0">
          <p className={`inline-block rounded-full px-2.5 py-0.5 text-sm font-semibold ${b.bg} ${b.text}`}>{a.band} potential client</p>
          <h1 className="mt-2 text-2xl font-bold leading-tight">{a.company}</h1>
          <p className="mt-2 text-ink-soft">{a.summary}</p>
          {a.pune_presence ? <p className="mt-2 text-sm"><span className="font-medium">Local presence: </span>{a.pune_presence}</p> : null}
          <p className="mt-3 text-xs text-ink-soft">Assessed {new Date(a.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}{run.error ? ` — ${run.error}` : ""}</p>
        </div>
      </header>

      <section className="rounded-2xl border border-line bg-surface px-6 py-2">
        <h2 className="pt-4 font-semibold">Why they could be a client ({a.for.length})</h2>
        {a.for.length ? <ul className="divide-y divide-line">{a.for.map((p, i) => <PointRow key={i} p={p} />)}</ul> : <p className="py-4 text-sm text-ink-soft">No supporting evidence found.</p>}
      </section>

      {a.against.length ? (
        <section className="rounded-2xl border border-line bg-surface px-6 py-2">
          <h2 className="pt-4 font-semibold">Reasons for caution ({a.against.length})</h2>
          <ul className="divide-y divide-line">{a.against.map((p, i) => <PointRow key={i} p={p} />)}</ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-semibold">Still unknown</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{a.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
      </section>

      <details className="rounded-2xl border border-line bg-surface p-6">
        <summary className="cursor-pointer font-semibold">How the score works, and sites read ({sources.length})</summary>
        <p className="mt-3 text-sm text-ink-soft">{a.method}</p>
        {run.queries?.length ? <p className="mt-3 text-sm"><span className="font-medium">Searched: </span>{(run.queries as string[]).join(" · ")}</p> : null}
        <ul className="mt-3 space-y-1 text-sm">{sources.map((s) => <li key={s.url}><a className={`hover:underline ${s.used ? "font-medium text-emerald-700" : ""}`} href={s.url} target="_blank" rel="noreferrer noopener">{host(s.url)}</a>{s.title ? <span className="text-ink-soft"> — {s.title}</span> : null}</li>)}</ul>
      </details>

      <div className="flex flex-wrap gap-3">
        <Link href={`/companies/${a.orgId}`} className="inline-flex min-h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold">Open company</Link>
        {hasRole(ctx, "editor") ? <ActionForm action={assessAction.bind(null, a.orgId)}><Submit variant="secondary">Assess again</Submit></ActionForm> : null}
      </div>
    </div>
  );
}
