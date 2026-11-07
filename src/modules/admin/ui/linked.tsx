import { requireContext } from "@/lib/auth/context";
import { LINKED, refOptions } from "../linked";
import { addLinkedAction, archiveLinkedAction, endEmploymentAction, proposeCurrentObservationAction } from "../actions/linked";
import { ActionForm, Submit } from "./client";

const inputCls = "min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm";

/** "+ Add …" disclosure with a labelled form for one linked-record kind. Hidden for viewers. */
export async function LinkedAdd({ kind, hostId, backPath, open = false }: { kind: string; hostId: string | null; backPath: string; open?: boolean }) {
  const ctx = await requireContext("viewer");
  if (ctx.role === "viewer") return null;
  const spec = LINKED[kind];
  const opts = await refOptions(ctx.db, ctx.workspaceId, spec, hostId);
  const action = addLinkedAction.bind(null, kind, hostId, backPath);
  const fid = (n: string) => `${kind}-${hostId ?? "ws"}-${n}`;
  return (
    <details className="mt-2 rounded-lg border border-dashed border-line px-3 py-2" open={open || undefined}>
      <summary className="cursor-pointer text-sm font-medium text-brand">+ {spec.title}</summary>
      <ActionForm action={action} className="mt-2 grid gap-2 sm:grid-cols-2">
        {spec.fields.map((f) => (
          <div key={f.name} className={f.kind === "textarea" ? "sm:col-span-2" : ""}>
            {f.kind === "checkbox" ? (
              <label className="flex min-h-10 items-center gap-2 text-sm" htmlFor={fid(f.name)}><input id={fid(f.name)} type="checkbox" name={f.name} /> {f.label}</label>
            ) : (
              <>
                <label className="mb-1 block text-xs font-medium text-ink-soft" htmlFor={fid(f.name)}>{f.label}{f.required ? " *" : ""}</label>
                {f.kind === "select" ? (
                  <select id={fid(f.name)} name={f.name} required={f.required} className={inputCls} defaultValue={f.options?.[0]?.[0]}>
                    {f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : f.kind === "ref" ? (
                  <select id={fid(f.name)} name={f.name} required={f.required} className={inputCls} defaultValue="">
                    <option value="">{(opts[f.name] ?? []).length ? "— choose —" : "— none yet: add one first —"}</option>
                    {(opts[f.name] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                ) : f.kind === "textarea" ? (
                  <textarea id={fid(f.name)} name={f.name} required={f.required} rows={2} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
                ) : (
                  <input id={fid(f.name)} name={f.name} required={f.required} className={inputCls}
                    type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"} step={f.kind === "number" ? "any" : undefined}
                    min={f.min} maxLength={f.kind === "text" ? 300 : undefined} />
                )}
                {f.hint ? <p className="mt-0.5 text-xs text-ink-soft">{f.hint}</p> : null}
              </>
            )}
          </div>
        ))}
        <div className="sm:col-span-2"><Submit>{spec.submit}</Submit></div>
      </ActionForm>
    </details>
  );
}

export function ArchiveLinked({ table, id, backPath }: { table: string; id: string; backPath: string }) {
  return (
    <ActionForm action={archiveLinkedAction.bind(null, table, id, backPath)} className="inline">
      <Submit variant="ghost" className="!min-h-0 px-1 text-xs" confirm="Archive this? It stays in history.">Archive</Submit>
    </ActionForm>
  );
}

export function EndRole({ id, backPath }: { id: string; backPath: string }) {
  return (
    <ActionForm action={endEmploymentAction.bind(null, id, backPath)} className="mt-1 flex flex-wrap items-center gap-1 text-xs">
      <label htmlFor={`end-${id}`} className="text-ink-soft">Ended on</label>
      <input id={`end-${id}`} type="date" name="end_date" required className="min-h-8 rounded border border-line px-2 text-xs" />
      <Submit variant="secondary" className="!min-h-8 text-xs">End role</Submit>
    </ActionForm>
  );
}

type Col = { key: string; label?: string; fmt?: "date" | "num" | "bool" };
/** Compact list of linked rows for a host (active only), with Archive. Labels resolve *_id columns via `joins`. */
export async function LinkedRows({ table, hostColumn, hostId, cols, backPath, filter, joins, empty, order, proposeCurrent }: {
  table: string; hostColumn: string; hostId: string; cols: Col[]; backPath: string; filter?: Record<string, string>;
  joins?: Record<string, { table: string; label: string }>; empty?: string; order?: string; proposeCurrent?: boolean;
}) {
  const ctx = await requireContext("viewer");
  let q = ctx.db.from(table).select(["id", ...cols.map((c) => c.key)].join(", ")).eq("workspace_id", ctx.workspaceId).eq(hostColumn, hostId).is("archived_at", null);
  for (const [k, v] of Object.entries(filter ?? {})) q = q.eq(k, v);
  const { data, error } = await q.order(order ?? "created_at", { ascending: true }).limit(200);
  if (error) return <p className="text-xs text-bad">Could not load {table.replace(/_/g, " ")}: {error.message}</p>;
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const names: Record<string, Map<string, string>> = {};
  for (const [col, j] of Object.entries(joins ?? {})) {
    const ids = [...new Set(rows.map((r) => r[col]).filter(Boolean))] as string[];
    if (!ids.length) continue;
    const { data: jd } = await ctx.db.from(j.table).select(`id, ${j.label}`).in("id", ids.slice(0, 100));
    names[col] = new Map(((jd ?? []) as unknown as Record<string, string>[]).map((x) => [x.id, x[j.label]]));
  }
  if (!rows.length) return empty ? <p className="text-sm text-ink-soft">{empty}</p> : null;
  const show = (c: Col, v: unknown) => v === null || v === undefined || v === "" ? <span className="text-ink-soft italic">unknown</span>
    : names[c.key]?.get(String(v)) ?? (c.fmt === "date" ? new Date(String(v)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : c.fmt === "num" ? Number(v).toLocaleString("en-IN") : c.fmt === "bool" ? (v ? "yes" : "no") : String(v).replace(/_/g, " "));
  return (
    <ul className="divide-y divide-line text-sm" data-linked={table}>
      {rows.map((r) => (
        <li key={String(r.id)} className="flex items-start justify-between gap-2 py-1.5">
          <span className="min-w-0 flex-1">{cols.map((c, i) => <span key={c.key}>{i ? <span className="text-ink-soft"> · </span> : null}{c.label ? <span className="text-ink-soft">{c.label} </span> : null}{show(c, r[c.key])}</span>)}
            {proposeCurrent && ctx.role !== "viewer" && r.verification !== "currently_confirmed" && rows.filter((x) => x.field === r.field).length > 1 ? <ProposeCurrent id={String(r.id)} backPath={backPath} /> : null}
            {proposeCurrent && r.verification === "currently_confirmed" ? <span className="ml-1 rounded bg-ok/10 px-1 text-xs text-ok">current value</span> : null}</span>
          {ctx.role !== "viewer" ? <ArchiveLinked table={table} id={String(r.id)} backPath={backPath} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function ProposeCurrent({ id, backPath }: { id: string; backPath: string }) {
  return (
    <ActionForm action={proposeCurrentObservationAction.bind(null, id, backPath)} className="mt-1 flex flex-wrap items-center gap-1 text-xs">
      <label htmlFor={`why-${id}`} className="sr-only">Reason</label>
      <input id={`why-${id}`} name="reason" required minLength={5} placeholder="Why is this the right value?" className="min-h-8 flex-1 rounded border border-line px-2 text-xs" />
      <Submit variant="secondary" className="!min-h-8 text-xs">Propose as current value</Submit>
    </ActionForm>
  );
}
