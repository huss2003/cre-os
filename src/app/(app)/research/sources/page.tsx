import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Textarea, ButtonLink } from "@/components/ui";
import { listSources, licensedSourceOptions } from "@/modules/intelligence/research/registry";
import { SOURCE_KINDS, ACQUISITION_METHODS, ALWAYS_PROHIBITED, OPTIONAL_PROHIBITED, licenceProblem } from "@/modules/intelligence/research/sources";
import { isoDate } from "@/modules/intelligence/common";
import { Flash, fmtDay, label } from "@/modules/intelligence/ui";
import { sourceAction, sourceToggleAction } from "../actions";

type Row = Record<string, unknown>;

export default async function SourcesPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; edit?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const isAdmin = hasRole(ctx, "admin");
  const [sources, licences] = await Promise.all([listSources(ctx.db, ctx.workspaceId), licensedSourceOptions(ctx.db, ctx.workspaceId)]);
  const editing = sp.edit ? sources.find((s) => s.id === sp.edit) ?? null : null;
  const today = isoDate(new Date())!;
  const licName = new Map(licences.map((l) => [l.id, l]));

  return (
    <div>
      <PageHeader title="Research sources" subtitle={<><Link className="text-brand" href="/research">Research</Link> · approved sources, licences and limits. Evidence must cite one of these (or be marked a manual note).</>} />
      <Flash sp={sp} />
      <p className="mb-4 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-soft">Always prohibited, for every source: {ALWAYS_PROHIBITED.map((m) => label(m)).join(", ")}. LinkedIn can only be a native alert or your own export. Web research runs only through an allowed “gateway web search” source within its daily limit.</p>

      <Card title={`Registry (${sources.length})`} className="mb-4">
        {sources.length === 0 ? (
          <EmptyState title="No approved sources yet">{isAdmin ? "Add the sources your team may use below — e.g. company press pages, filings, a licensed data export, or your own native alerts. Until then, evidence can only be stored as manual notes (lower evidence tier) and web research stays off." : "An admin needs to add approved sources. Until then, evidence can only be stored as manual notes."}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {sources.map((s) => {
              const lic = s.licensed_source_id ? licName.get(String(s.licensed_source_id)) ?? null : null;
              const licIssue = s.licensed_source_id ? licenceProblem(lic, today) : null;
              return (
                <li key={String(s.id)} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{String(s.name)}</span>
                    <Badge tone={s.allowed ? "ok" : "neutral"}>{s.allowed ? "allowed" : "disabled"}</Badge>
                    <Badge>{label(String(s.kind))}</Badge><Badge tone="brand">{label(String(s.acquisition_method))}</Badge>
                    {lic ? <Badge tone="accent">licensed: {lic.name}</Badge> : null}
                    {licIssue ? <Badge tone="bad">{licIssue}</Badge> : null}
                  </div>
                  <div className="mt-1 grid grid-cols-1 gap-x-4 text-xs text-ink-soft sm:grid-cols-2">
                    {s.base_url ? <span className="break-all">URL: {String(s.base_url)}</span> : null}
                    <span>Rate limit: {s.rate_limit_per_day === null ? "none set" : `${String(s.rate_limit_per_day)}/day`}{s.calls_day === today ? ` (${String(s.calls_today)} used today)` : ""}</span>
                    <span>Refresh: {s.refresh_cadence_days === null ? "not set" : `every ${String(s.refresh_cadence_days)} days`}</span>
                    <span>Licence: {String(s.licence ?? "—")}</span>
                    <span>Storage rights: {String(s.storage_rights ?? "—")}</span>
                    <span>Reuse rights: {String(s.reuse_rights ?? "—")}</span>
                    <span className="sm:col-span-2">Prohibited: {((s.prohibited_methods as string[]) ?? []).map((m) => label(m)).join(", ")}</span>
                    {s.last_error ? <span className="text-bad sm:col-span-2">Last error: {String(s.last_error)}</span> : null}
                    {s.last_success_at ? <span>Last success: {fmtDay(String(s.last_success_at))}</span> : null}
                  </div>
                  {isAdmin && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <ButtonLink variant="secondary" href={`/research/sources?edit=${s.id}`}>Edit</ButtonLink>
                      <form action={sourceToggleAction}><input type="hidden" name="id" value={String(s.id)} /><input type="hidden" name="allowed" value={s.allowed ? "0" : "1"} />
                        <Button variant={s.allowed ? "ghost" : "secondary"}>{s.allowed ? "Disable" : "Enable"}</Button></form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {isAdmin && <SourceForm row={editing} licences={licences} />}
      {!isAdmin && <p className="text-sm text-ink-soft">Only workspace admins can add or change approved sources.</p>}
    </div>
  );
}

function SourceForm({ row, licences }: { row: Row | null; licences: { id: string; name: string; expires_on: string | null }[] }) {
  const v = (k: string) => (row && row[k] !== null && row[k] !== undefined ? String(row[k]) : "");
  const prohibited = new Set((row?.prohibited_methods as string[] | undefined) ?? []);
  const extra = [...prohibited].filter((m) => !(ALWAYS_PROHIBITED as readonly string[]).includes(m) && !(OPTIONAL_PROHIBITED as readonly string[]).includes(m));
  return (
    <Card title={row ? `Edit “${v("name")}”` : "Add an approved source"} actions={row ? <ButtonLink variant="ghost" href="/research/sources">Cancel</ButtonLink> : null}>
      <form action={sourceAction} className="space-y-3">
        {row && <><input type="hidden" name="id" value={v("id")} /><input type="hidden" name="row_version" value={v("row_version")} /></>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name"><Input name="name" required minLength={2} maxLength={160} defaultValue={v("name")} placeholder="e.g. Company press releases" /></Field>
          <Field label="Kind"><Select name="kind" defaultValue={v("kind") || "website"}>{SOURCE_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
          <Field label="Acquisition method" hint="How content arrives. No scraping or automation is ever allowed."><Select name="acquisition_method" defaultValue={v("acquisition_method") || "manual_paste"}>{ACQUISITION_METHODS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
          <Field label="Base URL (optional)" hint="Pasted links must come from this site."><Input name="base_url" type="url" placeholder="https://" defaultValue={v("base_url")} /></Field>
          <Field label="Licence / terms"><Input name="licence" maxLength={500} defaultValue={v("licence")} placeholder="e.g. public press release; ToS allows citation" /></Field>
          <Field label="Licensed source" hint="Required for licensed data (purposes, AI permission, expiry).">
            <Select name="licensed_source_id" defaultValue={v("licensed_source_id")}>{[<option key="" value="">None</option>, ...licences.map((l) => <option key={l.id} value={l.id}>{l.name}{l.expires_on ? ` (until ${l.expires_on})` : ""}</option>)]}</Select>
          </Field>
          <Field label="Rate limit per day"><Input name="rate_limit_per_day" type="number" min={0} step={1} defaultValue={v("rate_limit_per_day")} /></Field>
          <Field label="Refresh cadence (days)"><Input name="refresh_cadence_days" type="number" min={0} step={1} defaultValue={v("refresh_cadence_days")} /></Field>
          <Field label="Storage rights"><Input name="storage_rights" maxLength={500} defaultValue={v("storage_rights")} placeholder="e.g. excerpts + link only, 12 months" /></Field>
          <Field label="Reuse rights"><Input name="reuse_rights" maxLength={500} defaultValue={v("reuse_rights")} placeholder="e.g. internal use only, no redistribution" /></Field>
          <Field label="Source owner"><Input name="source_owner" maxLength={160} defaultValue={v("source_owner")} /></Field>
          <Field label="Credentials owner"><Input name="credentials_owner" maxLength={160} defaultValue={v("credentials_owner")} /></Field>
        </div>
        <Field label="Failure policy"><Textarea name="failure_policy" maxLength={300} defaultValue={v("failure_policy")} placeholder="e.g. show stale banner; retry next day; never fall back to scraping" /></Field>
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">Prohibited methods</legend>
          <div className="flex flex-wrap gap-3">
            {ALWAYS_PROHIBITED.map((m) => <label key={m} className="flex items-center gap-1 text-ink-soft"><input type="checkbox" checked disabled readOnly /> {label(m)} (always)</label>)}
            {OPTIONAL_PROHIBITED.map((m) => <label key={m} className="flex items-center gap-1"><input type="checkbox" name="prohibited" value={m} defaultChecked={prohibited.has(m)} /> {label(m)}</label>)}
          </div>
          <div className="mt-2"><Field label="Other prohibited methods (comma-separated)"><Input name="prohibited_other" maxLength={300} defaultValue={extra.join(", ")} /></Field></div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowed" defaultChecked={row ? !!row.allowed : true} /> Allowed (can be cited / searched)</label>
        <Button type="submit">{row ? "Save changes" : "Add source"}</Button>
      </form>
    </Card>
  );
}
