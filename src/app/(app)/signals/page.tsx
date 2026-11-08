import { Suspense } from "react";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Badge, Field, Input, Textarea } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { listSignals, counts, VIEWS, type View } from "@/modules/signals/service";
import { ingestAction, scanAction } from "@/modules/signals/actions";
import { SignalCard } from "@/modules/signals/ui/card";

export const metadata = { title: "Signals" };
type SP = { view?: string; q?: string; confidence?: string; status?: string; assigned?: string; from?: string; to?: string };

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext("viewer");
  const view = (sp.view && sp.view in VIEWS ? sp.view : "all") as View;
  const [rows, c] = await Promise.all([
    listSignals(ctx.db, ctx.workspaceId, { view, q: sp.q, confidence: sp.confidence, status: sp.status, assigned: sp.assigned, userId: ctx.userId, from: sp.from, to: sp.to }),
    counts(ctx.db, ctx.workspaceId),
  ]);
  const href = (v: string) => `/signals?view=${v}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  const editor = ctx.role !== "viewer";
  return (
    <div className="space-y-4">
      <nav className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Signal views">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} href={href(v)} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${v === view ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink"}`}>
            {VIEWS[v]}{c[v] ? <span className="ml-1 opacity-75">{c[v]}</span> : null}
          </Link>))}
      </nav>
      <form method="get" className="grid gap-2 sm:grid-cols-6">
        <input type="hidden" name="view" value={view} />
        <label className="sr-only" htmlFor="sq">Search</label>
        <input id="sq" name="q" defaultValue={sp.q} placeholder="Search company, place, evidence…" className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm sm:col-span-2" />
        <select name="confidence" defaultValue={sp.confidence ?? ""} aria-label="Confidence" className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm">
          <option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="insufficient">Insufficient</option></select>
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status" className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm">
          <option value="">Open statuses</option><option value="new">New</option><option value="reviewing">Reviewing</option><option value="converted">Approved (task)</option><option value="approved">Approved</option></select>
        <select name="assigned" defaultValue={sp.assigned ?? ""} aria-label="Assigned" className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm">
          <option value="">Anyone</option><option value="me">Assigned to me</option></select>
        <button className="min-h-10 rounded-lg bg-brand px-3 text-sm text-white">Filter</button>
      </form>
      {rows.length === 0 ? (
        <Card><EmptyState title="No signals here yet">
          Signals come from lease dates in your database, evidence saved on companies, and text you paste below. Add a lease with an expiry date, or paste a news item, then press <b>Scan now</b>.
        </EmptyState></Card>
      ) : <div className="space-y-3">{rows.map((r) => <SignalCard key={r.id} s={r} />)}</div>}
      {editor ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Add evidence (paste news or a note)" help="Text is treated as untrusted evidence: it is only scanned for signals, never followed as instructions. Nothing is sent anywhere.">
            <ActionForm action={ingestAction} className="space-y-3">
              <Field label="Company name"><Input name="company" placeholder="e.g. ABC Technologies" /></Field>
              <Field label="Text"><Textarea name="text" rows={4} required placeholder="Paste the announcement, article or note…" /></Field>
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Source"><Input name="source" placeholder="Company press release" /></Field>
                <Field label="Link"><Input name="url" type="url" placeholder="https://…" /></Field>
                <Field label="Published"><Input name="published_on" type="date" /></Field>
              </div>
              <Submit>Find signals</Submit>
            </ActionForm>
          </Card>
          <Card title="Refresh" help="Checks lease dates and saved evidence now. It also runs by itself every morning at 06:00. Re-running never creates duplicates.">
            <p className="mb-3 text-sm text-ink-soft">Looks at lease expiries, lock-ins, notice deadlines, break and renewal options, and evidence saved on companies and people.</p>
            <ActionForm action={scanAction}><Submit>Scan now</Submit></ActionForm>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return (<><PageHeader title="Signals" subtitle="Events that may matter for a client's office: what happened, the evidence, what is unconfirmed, and what to do next." />
    <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense></>);
}
