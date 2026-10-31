import Link from "next/link";
import { Suspense } from "react";
import { Badge, Button, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Select, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { listSources } from "@/modules/imports/service";
import { Loading } from "@/modules/imports/ui";
import { createSourceAction, sourceDecisionAction } from "../actions";

export const metadata = { title: "Import sources" };
type SP = Promise<Record<string, string | string[] | undefined>>;

const KIND: Record<string, string> = { manual_upload: "Manual upload", folder: "Shared folder", export: "System export", connector: "Connector", email: "Email attachment", other: "Other" };

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext("editor");
  const sp = await searchParams;
  const sources = await listSources(ctx);
  const admin = hasRole(ctx, "admin");
  const error = typeof sp.error === "string" ? sp.error : null;
  return (
    <>
      <PageHeader title="Import sources" subtitle="Only files from approved sources/folders are read into CRE OS. A file from an unknown source is stored read-only and quarantined until an admin approves the source."
        actions={<ButtonLink variant="ghost" href="/imports">All imports</ButtonLink>} />
      {error ? <StaleBanner>{error}</StaleBanner> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title={`Sources (${sources.length})`}>
          {sources.length === 0 ? <EmptyState title="No sources yet">Add the folders and exports your team imports from.</EmptyState> : (
            <ul className="divide-y divide-line">
              {sources.map((s) => (
                <li key={s.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={s.approved ? "ok" : "warn"}>{s.approved ? "approved" : "not approved"}</Badge>
                    <Badge>{KIND[s.kind] ?? s.kind}</Badge>
                    {s.waiting ? <Badge tone="warn">{s.waiting} file{s.waiting > 1 ? "s" : ""} quarantined</Badge> : null}
                  </div>
                  <p className="text-xs text-ink-soft">{s.location ?? ""}{s.approved && s.approved_at ? ` · approved ${fmt(s.approved_at)}` : ""}{s.note ? ` · ${s.note}` : ""}</p>
                  {admin ? (
                    <form action={sourceDecisionAction} className="mt-2 flex gap-2">
                      <input type="hidden" name="source_id" value={s.id} />
                      {s.approved
                        ? <Button variant="ghost" type="submit" name="decision" value="revoke">Revoke</Button>
                        : <Button variant="secondary" type="submit" name="decision" value="approve">Approve{s.waiting ? " and process waiting files" : ""}</Button>}
                    </form>
                  ) : !s.approved ? <p className="mt-1 text-xs text-ink-soft">Ask an admin to approve this source.</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Add a source">
          <form action={createSourceAction} className="space-y-3">
            <Field label="Name"><Input name="name" required minLength={2} maxLength={120} placeholder="e.g. Research team monthly export" /></Field>
            <Field label="Kind">
              <Select name="kind" defaultValue="export">
                <option value="folder">Shared folder</option><option value="export">System export</option><option value="email">Email attachment</option>
                <option value="connector">Connector</option><option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Folder / location" hint="Informational"><Input name="location" maxLength={300} /></Field>
            {admin ? <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" name="approve" value="1" /> Approve now</label>
              : <p className="text-xs text-ink-soft">New sources start unapproved; an admin approves them.</p>}
            <Button type="submit" className="w-full">Add source</Button>
          </form>
          <p className="mt-3 text-xs text-ink-soft">See <Link className="underline" href="/imports">Imports</Link> for batches waiting on a source.</p>
        </Card>
      </div>
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
