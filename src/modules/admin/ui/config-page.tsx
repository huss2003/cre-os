/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import type { AppContext } from "@/lib/auth/context";
import { listConfig, type ConfigKind } from "../config";
import { archiveConfigAction, createConfigAction, updateConfigAction } from "../actions/settings";
import { ActionForm, Submit, TemplateFileInput } from "./client";
import { fmtDate } from "./parts";

type Row = Record<string, any>;

export interface ConfigField {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea" | "json" | "checkbox" | "select" | "list" | "classes" | "file";
  options?: [string, string][];
  hint?: string;
  required?: boolean;
}

const CLASS_OPTS: [string, string][] = [["public", "Public"], ["permitted_personal", "Permitted personal"], ["corporate_confidential", "Corporate confidential"], ["licensed_restricted", "Licensed restricted"]];

function dv(row: Row | null, f: ConfigField): string {
  const v = row?.[f.name];
  if (v === null || v === undefined) return "";
  if (f.type === "json") return JSON.stringify(v, null, 2);
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function Input_({ f, row, ws }: { f: ConfigField; row: Row | null; ws: string }) {
  switch (f.type) {
    case "textarea": return <Textarea name={f.name} defaultValue={dv(row, f)} rows={2} />;
    case "json": return <Textarea name={f.name} defaultValue={dv(row, f) || "{}"} rows={4} className="font-mono text-xs" />;
    case "select": return <Select name={f.name} defaultValue={dv(row, f) || f.options?.[0]?.[0]}>{f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>;
    case "checkbox": return <input type="checkbox" name={f.name} defaultChecked={f.name === "approved" && row && "approved_at" in row ? !!row.approved_at : !!row?.[f.name] || (!row && f.name === "active")} className="h-5 w-5" />;
    case "classes": return (
      <span className="flex flex-wrap gap-x-3 gap-y-1">{CLASS_OPTS.map(([v, l]) => (
        <label key={v} className="flex items-center gap-1"><input type="checkbox" name={f.name} value={v} defaultChecked={(row?.[f.name] ?? []).includes(v)} />{l}</label>))}</span>
    );
    case "file": return <TemplateFileInput workspaceId={ws} />;
    default: return <Input name={f.name} type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "numeric" : undefined} defaultValue={dv(row, f)} required={f.required} />;
  }
}

function Fields({ fields, row, ws }: { fields: ConfigField[]; row: Row | null; ws: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.name} className={f.type === "json" || f.type === "textarea" || f.type === "classes" ? "sm:col-span-2" : undefined}>
          <Field label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}><Input_ f={f} row={row} ws={ws} /></Field>
        </div>
      ))}
    </div>
  );
}

export async function ConfigPage({ ctx, kind, fields, title, emptyText, summary, archived }: {
  ctx: AppContext; kind: ConfigKind; fields: ConfigField[]; title: string; emptyText: ReactNode;
  summary: (r: Row) => ReactNode; archived: boolean;
}) {
  const rows = await listConfig(ctx.db, ctx.workspaceId, kind, { archived });
  return (
    <div className="space-y-4">
      {!archived ? (
        <Card title={`Add ${title}`}>
          <ActionForm action={createConfigAction.bind(null, kind)} className="space-y-3">
            <Fields fields={fields} row={null} ws={ctx.workspaceId} />
            <Submit>Add</Submit>
          </ActionForm>
        </Card>
      ) : null}
      <div className="flex justify-end text-sm"><Link className="text-brand" href={archived ? "?" : "?archived=1"}>{archived ? "Show active" : "Show archived"}</Link></div>
      {rows.length === 0 ? <EmptyState title={archived ? "Nothing archived" : `No ${title} yet`}>{archived ? null : emptyText}</EmptyState> : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{r.name}</span>{summary(r)}</div>
              <p className="text-xs text-ink-soft">Updated {fmtDate(r.updated_at, true)} · version {r.row_version}</p>
              {!archived ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-brand">Edit</summary>
                  <ActionForm action={updateConfigAction.bind(null, kind, r.id)} className="mt-2 space-y-3">
                    <input type="hidden" name="row_version" value={String(r.row_version)} />
                    {kind === "template_asset" ? <input type="hidden" name="version" value={String(r.version ?? 1)} /> : null}
                    <Fields fields={fields} row={r} ws={ctx.workspaceId} />
                    <Submit variant="secondary">Save</Submit>
                  </ActionForm>
                </details>
              ) : null}
              <ActionForm action={archiveConfigAction.bind(null, kind, r.id)} className="mt-2">
                {archived ? <input type="hidden" name="restore" value="1" /> : null}
                <Submit variant="ghost" confirm={archived ? undefined : "Archive this record? It stays in history."}>{archived ? "Restore" : "Archive"}</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Yes({ on, yes, no }: { on: unknown; yes: string; no?: string }) {
  return on ? <Badge tone="ok">{yes}</Badge> : no ? <Badge tone="warn">{no}</Badge> : null;
}
