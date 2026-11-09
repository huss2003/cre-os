import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { retryAction } from "@/modules/contacts/actions";
import { STAGE, ROLE, host } from "@/modules/contacts/ui/parts";

export const metadata = { title: "Enrichment run" };
type Row = Record<string, any>;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const { data: j } = await ctx.db.from("enrichment_job").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!j) notFound();
  const { data: items } = await ctx.db.from("enrichment_item").select("id, full_name, stage, decision, role_class, completeness, person_id, match_reason").eq("job_id", id).order("created_at");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/contacts?tab=history" className="text-sm text-ink-soft hover:text-ink">History</Link>
      <header className="rounded-2xl border border-line bg-surface p-6">
        <h1 className="text-xl font-bold">{j.label}</h1>
        <p className="mt-1 text-sm text-ink-soft">{new Date(j.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · status {j.status} · {j.done}/{j.total} done{j.failed ? `, ${j.failed} failed` : ""} · sources: {(j.sources ?? []).join(", ")}{Number(j.usd) ? ` · AI $${Number(j.usd).toFixed(3)}` : ""}</p>
        {j.error ? <p className="mt-3 rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-900">{j.error}</p> : null}
        <div className="mt-4 flex gap-2">
          {hasRole(ctx, "editor") && ["failed", "partial"].includes(j.status) ? <ActionForm action={retryAction.bind(null, id)}><Submit>Retry</Submit></ActionForm> : null}
          <a href={`/api/v1/contacts/jobs/${id}/report`} className="inline-flex min-h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold">Download report (CSV)</a>
        </div>
      </header>
      {(j.queries ?? []).length ? <p className="text-sm"><span className="font-medium">Searched:</span> {(j.queries as string[]).join(" · ")}</p> : null}
      <section className="rounded-2xl border border-line bg-surface">
        <h2 className="px-5 pt-5 font-semibold">People ({(items ?? []).length})</h2>
        <ul className="mt-2 divide-y divide-line">
          {((items ?? []) as Row[]).map((it) => <li key={it.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"><span className="min-w-0 flex-1">{it.person_id ? <Link className="font-medium hover:text-brand" href={`/contacts/${it.person_id}`}>{it.full_name}</Link> : <span className="font-medium">{it.full_name}</span>}<span className="block text-xs text-ink-soft">{it.match_reason}</span></span><span className="text-xs">{ROLE[it.role_class ?? "unknown"]}</span><span className="text-xs">{it.completeness}%</span><span className="rounded-full bg-canvas px-2 py-0.5 text-xs">{it.decision === "pending" ? STAGE[it.stage] : it.decision}</span></li>)}
          {!(items ?? []).length ? <li className="px-5 py-4 text-sm text-ink-soft">No people in this run.</li> : null}
        </ul>
      </section>
      {(j.sites ?? []).length ? (
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="font-semibold">Sites read ({(j.sites as Row[]).length})</h2>
          <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{(j.sites as Row[]).map((s, i) => <li key={i}><a className={`hover:underline ${s.used ? "font-medium text-emerald-700" : ""}`} href={s.url} target="_blank" rel="noreferrer noopener">{host(s.url)}</a>{s.title ? <span className="text-ink-soft"> — {s.title}</span> : null}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}
