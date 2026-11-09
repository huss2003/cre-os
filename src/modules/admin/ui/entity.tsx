/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import Link from "next/link";
import { Badge, ButtonLink, EmptyState, Field, Input, MoreFields, Select, Textarea } from "@/components/ui";
import type { AppContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/context";
import { listEntities, memberDirectory, type EntityTable } from "../entities";
import { archiveEntityAction, createEntityAction, saveEntityAction, shareAction } from "../actions/entities";
import { ActionForm, Submit } from "./client";
import { ENTITY_FIELDS, ENTITY_LABEL, ENTITY_ROUTE, type FieldDef } from "./entity-fields";
import { ClassBadge, fmtDate } from "./parts";

type Row = Record<string, any>;

function valueOf(row: Row | null, f: FieldDef): string {
  const v = row?.[f.name];
  if (v === null || v === undefined) return f.name === "classification" ? "corporate_confidential" : f.name === "asset_kind" ? "building" : "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function FieldInput({ f, row, options }: { f: FieldDef; row: Row | null; options?: [string, string][] }) {
  const dv = valueOf(row, f);
  const opts = options ?? f.options;
  if (f.type === "select" && opts) {
    return <Select name={f.name} defaultValue={dv}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>;
  }
  if (f.type === "textarea") return <Textarea name={f.name} defaultValue={dv} rows={3} />;
  return <Input name={f.name} type={f.type === "number" ? "text" : f.type ?? "text"} inputMode={f.type === "number" ? "decimal" : undefined}
    defaultValue={dv} required={f.required} />;
}

/** Create (row = null) or edit form for a company/person/building. Material fields are labelled. */
export function EntityForm({ table, row, parentOptions, localityOptions }: { table: EntityTable; row: Row | null; parentOptions?: [string, string][]; localityOptions?: [string, string][] }) {
  const action = row ? saveEntityAction.bind(null, table, row.id as string) : createEntityAction.bind(null, table);
  return (
    <ActionForm action={action} className="space-y-4">
      {row ? <input type="hidden" name="row_version" value={String(row.row_version)} /> : null}
      {(() => {
        // Essentials first (required + first two fields); everything optional sits behind "More details".
        const all = ENTITY_FIELDS[table];
        const main = all.filter((f, i) => f.required || i < 2);
        const more = all.filter((f) => !main.includes(f));
        const render = (f: (typeof all)[number]) => (
          <Field key={f.name} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint || (row && f.material) ? <>{f.hint}{row && f.material ? <span className="block text-warn">Changes go to Approvals before they apply.</span> : null}</> : undefined}>
            <FieldInput f={f} row={row} options={f.name === "parent_asset_id" ? [["", "— none —"], ...(parentOptions ?? [])] : f.name === "locality_id" ? [["", "— unknown —"], ...(localityOptions ?? [])] : undefined} />
          </Field>
        );
        return (
          <div className="max-w-md space-y-4">
            {main.map(render)}
            {more.length ? <MoreFields>{more.map(render)}</MoreFields> : null}
          </div>
        );
      })()}
      <div className="flex flex-wrap gap-2">
        <Submit>{row ? "Save changes" : `Create ${ENTITY_LABEL[table]}`}</Submit>
        <ButtonLink variant="secondary" href={row ? `${ENTITY_ROUTE[table]}/${row.id}` : ENTITY_ROUTE[table]}>Cancel</ButtonLink>
      </div>
    </ActionForm>
  );
}

/** Share-with-colleague (record_share) — owners/admins only. */
export async function ShareCard({ ctx, table, id, shares }: { ctx: AppContext; table: EntityTable; id: string; shares: Row[] }) {
  if (!hasRole(ctx, "admin")) return null;
  const members = await memberDirectory(ctx.db, ctx.workspaceId);
  const shared = new Set(shares.map((s) => s.user_id as string));
  const candidates = members.filter((m) => !shared.has(m.user_id) && m.role !== "owner" && m.role !== "admin");
  return (
    <div className="space-y-3 text-sm">
      {shares.length ? (
        <ul className="space-y-1">
          {shares.map((s) => (
            <li key={s.user_id} className="flex items-center justify-between gap-2">
              <span>{members.find((m) => m.user_id === s.user_id)?.display_name ?? "Former member"} <span className="text-xs text-ink-soft">since {fmtDate(s.created_at)}</span></span>
              <ActionForm action={shareAction.bind(null, table, id)}>
                <input type="hidden" name="user_id" value={s.user_id} />
                <input type="hidden" name="op" value="unshare" />
                <Submit variant="ghost" confirm="Remove this colleague's access?">Remove</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      ) : <p className="text-ink-soft">Only owners, admins, members who see all accounts, and the record owner can open this.</p>}
      {candidates.length ? (
        <ActionForm action={shareAction.bind(null, table, id)} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="op" value="share" />
          <Select name="user_id" defaultValue="" className="max-w-xs">
            <option value="" disabled>Choose colleague…</option>
            {candidates.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.role})</option>)}
          </Select>
          <Submit variant="secondary">Share</Submit>
        </ActionForm>
      ) : <p className="text-xs text-ink-soft">No other colleagues to share with.</p>}
    </div>
  );
}

export function ArchiveCard({ ctx, table, row }: { ctx: AppContext; table: EntityTable; row: Row }) {
  if (!hasRole(ctx, "editor")) return null;
  const archived = !!row.archived_at;
  if (archived && !hasRole(ctx, "admin")) return <p className="text-sm text-ink-soft">Archived {fmtDate(row.archived_at)}. Ask an admin to restore it.</p>;
  return (
    <ActionForm action={archiveEntityAction.bind(null, table, row.id as string)} className="space-y-2 text-sm">
      <input type="hidden" name="row_version" value={String(row.row_version)} />
      {archived ? (
        <>
          <input type="hidden" name="restore" value="1" />
          <p className="text-ink-soft">Archived {fmtDate(row.archived_at)}. History and evidence were kept.</p>
          <Submit variant="secondary">Restore</Submit>
        </>
      ) : (
        <>
          <p className="text-ink-soft">Records are archived, never deleted. Archiving needs approval.</p>
          <Input name="reason" placeholder="Reason (e.g. duplicate, closed down)" />
          <Submit variant="danger" confirm={`Request archive of this ${ENTITY_LABEL[table]}?`}>Request archive</Submit>
        </>
      )}
    </ActionForm>
  );
}

const LIST_HEAD: Record<EntityTable, string[]> = {
  organisation: ["Company", "Sector", "Domain", "Class", "Updated"],
  person: ["Person", "Also known as", "Restrictions", "Class", "Updated"],
  asset: ["Building", "Kind", "Status", "Class", "Updated"],
};

/** List page body with name filter, archived toggle and paging. */
export async function EntityList({ ctx, table, sp }: { ctx: AppContext; table: EntityTable; sp: Record<string, string | string[] | undefined> }) {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const q = one("q") ?? "";
  const archived = one("archived") === "1";
  const page = Math.max(0, Number(one("page") ?? 0) || 0);
  const base = ENTITY_ROUTE[table];
  const { rows, total, pageSize } = await listEntities(ctx.db, ctx.workspaceId, table, { q, archived, page });
  const label = ENTITY_LABEL[table];
  const qs = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (archived) u.set("archived", "1");
    for (const [k, v] of Object.entries(p)) if (v !== undefined) u.set(k, String(v));
    return `${base}?${u}`;
  };
  return (
    <div className="space-y-4">
      <form action={base} className="flex flex-wrap gap-2">
        <Input name="q" defaultValue={q} placeholder={`Filter ${label} names…`} className="max-w-sm" />
        {archived ? <input type="hidden" name="archived" value="1" /> : null}
        <button className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm">Filter</button>
        <Link className="min-h-10 px-2 py-2 text-sm text-brand" href={archived ? base : `${base}?archived=1`}>{archived ? "Show active" : "Show archived"}</Link>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={q ? `No ${label} matches “${q}”` : archived ? `No archived ${label} records` : `No ${label} records yet`}
          action={!archived && hasRole(ctx, "editor") ? <ButtonLink href={`${base}/new`}>Add {label}</ButtonLink> : undefined}>
          {q ? <>Try <Link className="text-brand underline" href={`/search?q=${encodeURIComponent(q)}`}>full search</Link>, which also matches aliases, emails and identifiers.</>
            : <>Records arrive from imports, captures and connectors, or you can add one by hand. You only see records you own, that are shared with you, or that your role allows.</>}
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface sm:hidden">
            {rows.map((r) => (
              <li key={r.id as string} className="p-3">
                <Link href={`${base}/${r.id}`} className="font-medium text-brand">{(r.display_name ?? r.full_name ?? r.name) as string}</Link>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-ink-soft">
                  <ClassBadge value={r.classification} />
                  {r.sector ? <Badge>{r.sector}</Badge> : null}
                  {r.asset_kind ? <Badge>{r.asset_kind}</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface sm:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-ink-soft">
                <tr>{LIST_HEAD[table].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id as string}>
                    <td className="px-3 py-2"><Link href={`${base}/${r.id}`} className="font-medium text-brand">{(r.display_name ?? r.full_name ?? r.name) as string}</Link></td>
                    <td className="px-3 py-2">{table === "organisation" ? r.sector ?? "—" : table === "person" ? (r.aliases ?? []).join(", ") || "—" : r.asset_kind}</td>
                    <td className="px-3 py-2">{table === "organisation" ? r.domain ?? "—" : table === "person" ? r.contact_restrictions ?? "—" : r.status ?? "—"}</td>
                    <td className="px-3 py-2"><ClassBadge value={r.classification} /></td>
                    <td className="px-3 py-2 text-ink-soft">{fmtDate(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-ink-soft">
            <span>{total} {label} record{total === 1 ? "" : "s"}</span>
            <span className="flex gap-3">
              {page > 0 ? <Link className="text-brand" href={qs({ page: page - 1 })}>Previous</Link> : null}
              {(page + 1) * pageSize < total ? <Link className="text-brand" href={qs({ page: page + 1 })}>Next</Link> : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
