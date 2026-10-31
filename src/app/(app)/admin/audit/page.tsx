import { Suspense } from "react";
import Link from "next/link";
import { Badge, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { listAudit } from "@/modules/admin/health";
import { memberDirectory } from "@/modules/admin/entities";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Audit log" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAdminPage("admin", "/admin/audit");
  const sp = await searchParams;
  const f = { entityType: one(sp.entity_type), action: one(sp.action), actorKind: one(sp.actor_kind), entityId: one(sp.entity_id),
    from: one(sp.from)?.match(/^\d{4}-\d{2}-\d{2}$/) ? one(sp.from) : undefined, to: one(sp.to)?.match(/^\d{4}-\d{2}-\d{2}$/) ? one(sp.to) : undefined,
    page: Number(one(sp.page) ?? 0) || 0 };
  const [{ rows, total, page, pageSize }, members] = await Promise.all([listAudit(ctx.db, ctx.workspaceId, f), memberDirectory(ctx.db, ctx.workspaceId)]);
  const who = (id: string | null) => members.find((m) => m.user_id === id)?.display_name ?? (id ? "former member" : "");
  const qs = (p: number) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "page") u.set(k, v); u.set("page", String(p)); return `/admin/audit?${u}`; };
  return (
    <div className="space-y-4">
      <form action="/admin/audit" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Input name="entity_type" defaultValue={f.entityType ?? ""} placeholder="Entity type" />
        <Input name="action" defaultValue={f.action ?? ""} placeholder="Action" />
        <Select name="actor_kind" defaultValue={f.actorKind ?? ""}><option value="">Any actor</option><option value="user">User</option><option value="job">Job</option><option value="system">System</option><option value="model">Model</option></Select>
        <Input type="date" name="from" defaultValue={f.from ?? ""} aria-label="From" />
        <Input type="date" name="to" defaultValue={f.to ?? ""} aria-label="To" />
        <button className="min-h-10 rounded-lg bg-brand px-3 text-sm text-white">Filter</button>
      </form>
      {rows.length === 0 ? <EmptyState title="No audit events match">Every change to business records, approvals, pauses and member changes is recorded here.</EmptyState> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="p-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-ink-soft">{fmtDate(r.occurred_at, true)}</span><Badge tone="brand">{r.action}</Badge><span>{r.entity_type}</span>
                <Badge>{r.actor_kind}{r.actor_user_id ? `: ${who(r.actor_user_id)}` : ""}</Badge>{r.change_proposal_id ? <Badge tone="ok">approved change</Badge> : null}{r.model ? <Badge tone="accent">{r.model}</Badge> : null}</div>
              {r.entity_id ? <Link className="text-xs text-brand" href={`/admin/audit?entity_id=${r.entity_id}`}>{r.entity_id}</Link> : null}
              {r.before || r.after ? (
                <details className="mt-1 text-xs"><summary className="cursor-pointer text-ink-soft">Details</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-canvas p-2">{JSON.stringify({ before: r.before, after: r.after, request_id: r.request_id, job_id: r.job_id }, null, 2)}</pre></details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between text-sm text-ink-soft"><span>{total} events</span><span className="flex gap-3">{page > 0 ? <Link className="text-brand" href={qs(page - 1)}>Newer</Link> : null}{(page + 1) * pageSize < total ? <Link className="text-brand" href={qs(page + 1)}>Older</Link> : null}</span></div>
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of changes, approvals and administrative actions." />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
