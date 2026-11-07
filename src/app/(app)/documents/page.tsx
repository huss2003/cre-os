import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { approveDocumentAction, generateDocumentAction, refreshDocumentAction, releaseDocumentAction } from "@/modules/deals/actions";
import { regenerateDocumentAction } from "@/modules/deals/actions-b";
import { PURPOSES, listDocuments } from "@/modules/deals/documents/service";
import { DocStatusBadge, Flash } from "@/modules/deals/ui";

type Doc = { id: string; kind: string; purpose: string; status: string; sha256: string; created_at: string; linked_entity_id: string; input_versions: Record<string, unknown> | null;
  family_id: string | null; version_no: number | null; stale_reasons: unknown; released_at: string | null; approved_hash: string | null };
/** One row per document family (latest version first); all versions — incl. earlier approved/released ones — listed. */
function families(docs: Doc[]) {
  const by = new Map<string, Doc[]>();
  for (const d of docs) by.set(d.family_id ?? d.id, [...(by.get(d.family_id ?? d.id) ?? []), d]);
  return [...by.values()].map((v) => { v.sort((a, b) => (b.version_no ?? 1) - (a.version_no ?? 1)); return { latest: v[0], versions: v }; })
    .sort((a, b) => b.latest.created_at.localeCompare(a.latest.created_at));
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const requirementId = typeof sp.requirement === "string" ? sp.requirement : undefined;
  const [docs, { data: reqs }, { data: scen }, { data: tpls }] = await Promise.all([
    listDocuments(ctx, { requirementId }),
    ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    ctx.db.from("finance_scenario").select("id, name, requirement_id, approved_at").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(100),
    ctx.db.from("template_asset").select("id, purpose, name, version, approved").eq("workspace_id", ctx.workspaceId).is("archived_at", null),
  ]);
  const title = (id: unknown) => (reqs ?? []).find((r) => r.id === id)?.title ?? "—";
  const isAdmin = hasRole(app, "admin");
  return (
    <div className="space-y-5">
      <PageHeader title="Documents" subtitle="Editable PPTX / DOCX / XLSX with native charts and a schematic location map, built from current inputs. Each generation is a new version; earlier approved versions are kept. A requirement, availability, quote or scenario change makes dependent documents stale at once — stale documents cannot be approved or released." />
      <Flash sp={sp} />
      {(tpls ?? []).length === 0 && <p className="text-sm text-ink-soft">No tenant templates configured — documents use a neutral built-in layout. Add your approved templates and brand (colours, fonts, disclaimer) in template settings.</p>}
      {app.role !== "viewer" && (
        <Card title="Generate">
          {(reqs ?? []).length === 0 ? <p className="text-sm text-ink-soft">Create a requirement first.</p> : (
            <form action={generateDocumentAction} className="grid gap-3 sm:grid-cols-2">
              <Field label="Document"><Select name="purpose" defaultValue="shortlist_deck">{PURPOSES.map((p) => <option key={p.purpose} value={p.purpose}>{p.label}</option>)}</Select></Field>
              <Field label="Requirement"><Select name="requirement_id" required defaultValue={requirementId ?? ""}><option value="">— choose —</option>{(reqs ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select></Field>
              <Field label="Finance scenarios (same horizon)" hint="Hold Ctrl/⌘ to pick several. Required for the XLSX comparison.">
                <Select name="scenario_ids" multiple className="min-h-24">{(scen ?? []).filter((s) => !requirementId || s.requirement_id === requirementId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.approved_at ? " ✓" : ""}</option>)}</Select>
              </Field>
              <Field label="Prepared for (recipient name)"><Input name="prepared_for" /></Field>
              <div className="sm:col-span-2"><Button type="submit">Generate draft</Button></div>
            </form>
          )}
        </Card>
      )}
      {docs.length === 0 ? (
        <EmptyState title="No documents yet">Generate a shortlist deck, proposal, market note or financial comparison from a requirement.</EmptyState>
      ) : (
        <Table head={["Document", "Requirement", "Status", "Versions", "Actions"]}>
          {families(docs as Doc[]).map(({ latest: d, versions }) => {
            const iv = (d.input_versions ?? {}) as Record<string, unknown>;
            const reasons = (d.stale_reasons ?? []) as { reason: string; at: string; was: string }[];
            const wasReleased = d.status === "stale" && (d.released_at || reasons.some((r) => r.was === "released"));
            return (
              <tr key={d.id}>
                <Td>
                  <div className="font-medium">{(iv.title as string) ?? d.purpose} <span className="text-xs text-ink-soft">v{d.version_no ?? 1}</span></div>
                  <div className="text-xs text-ink-soft">{String(d.kind).toUpperCase()} · sha {String(d.sha256).slice(0, 10)} · {new Date(d.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}{iv.released_to ? ` · released to ${iv.released_to}` : ""}</div>
                  {d.status === "stale" && reasons.length > 0 && <div className="mt-1 text-xs text-bad">{wasReleased ? "Was shared — inputs changed, re-review before sharing again: " : "Stale: "}{[...new Set(reasons.map((r) => r.reason))].join("; ")}</div>}
                  {Array.isArray(iv.sources) && (
                    <details className="mt-1 text-xs"><summary className="cursor-pointer text-brand">Sources &amp; calculation versions</summary>
                      <ul className="mt-1 list-disc pl-4 text-ink-soft">{(iv.sources as string[]).map((x, i) => <li key={i}>{x}</li>)}{((iv.template_carry_over ?? []) as string[]).map((x, i) => <li key={`t${i}`}>{x}</li>)}</ul>
                    </details>
                  )}
                </Td>
                <Td>{title(d.linked_entity_id)}</Td>
                <Td><DocStatusBadge s={d.status} />{wasReleased && <div className="mt-1"><Badge tone="warn">was released</Badge></div>}</Td>
                <Td>
                  <details className="text-xs"><summary className="cursor-pointer">{versions.length} version{versions.length > 1 ? "s" : ""}</summary>
                    <ul className="mt-1 space-y-1">{versions.map((v) => (
                      <li key={v.id}><a className="text-brand underline" href={`/api/v1/documents/${v.id}/download`}>v{v.version_no ?? 1}</a> · {v.status}{v.approved_hash ? " · approved" : ""}{v.released_at ? ` · released ${v.released_at.slice(0, 10)}` : ""} · {v.created_at.slice(0, 10)}</li>
                    ))}</ul>
                  </details>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <a className="rounded-lg border border-line px-2 py-1 text-xs" href={`/api/v1/documents/${d.id}/download`}>Download</a>
                    {app.role !== "viewer" && d.status !== "stale" && <form action={refreshDocumentAction}><input type="hidden" name="id" value={d.id} /><Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" type="submit">Check freshness</Button></form>}
                    {isAdmin && ["draft", "in_review"].includes(d.status) && <form action={approveDocumentAction}><input type="hidden" name="id" value={d.id} /><Button variant="secondary" className="min-h-0 px-2 py-1 text-xs" type="submit">Approve</Button></form>}
                    {isAdmin && d.status === "approved" && (
                      <form action={releaseDocumentAction} className="flex gap-1"><input type="hidden" name="id" value={d.id} /><Input name="recipient" placeholder="Recipient" required className="w-32 py-1 text-xs" /><Button className="min-h-0 px-2 py-1 text-xs" type="submit">Release</Button></form>
                    )}
                    {app.role !== "viewer" && <form action={regenerateDocumentAction}><input type="hidden" name="id" value={d.id} /><Button variant={d.status === "stale" ? "primary" : "ghost"} className="min-h-0 px-2 py-1 text-xs" type="submit">New version</Button></form>}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
