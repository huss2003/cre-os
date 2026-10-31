import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { approveDocumentAction, generateDocumentAction, refreshDocumentAction, releaseDocumentAction } from "@/modules/deals/actions";
import { PURPOSES, listDocuments } from "@/modules/deals/documents/service";
import { DocStatusBadge, Flash } from "@/modules/deals/ui";

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
      <PageHeader title="Documents" subtitle="Editable PPTX / DOCX / XLSX built from current inputs. Stale documents cannot be approved or released." />
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
        <Table head={["Document", "Requirement", "Status", "Created", "Actions"]}>
          {(docs as Record<string, unknown>[]).map((d) => {
            const iv = (d.input_versions ?? {}) as Record<string, unknown>;
            return (
              <tr key={d.id as string}>
                <Td><div className="font-medium">{(iv.title as string) ?? d.purpose as string}</div><div className="text-xs text-ink-soft">{String(d.kind).toUpperCase()} · sha {String(d.sha256).slice(0, 10)}{iv.released_to ? ` · released to ${iv.released_to}` : ""}</div></Td>
                <Td>{title(d.linked_entity_id)}</Td>
                <Td><DocStatusBadge s={d.status as string} /></Td>
                <Td className="text-xs">{new Date(d.created_at as string).toLocaleString("en-IN")}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <a className="rounded-lg border border-line px-2 py-1 text-xs" href={`/api/v1/documents/${d.id}/download`}>Download</a>
                    {app.role !== "viewer" && d.status !== "released" && <form action={refreshDocumentAction}><input type="hidden" name="id" value={d.id as string} /><Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" type="submit">Check freshness</Button></form>}
                    {isAdmin && ["draft", "in_review"].includes(d.status as string) && <form action={approveDocumentAction}><input type="hidden" name="id" value={d.id as string} /><Button variant="secondary" className="min-h-0 px-2 py-1 text-xs" type="submit">Approve</Button></form>}
                    {isAdmin && d.status === "approved" && (
                      <form action={releaseDocumentAction} className="flex gap-1"><input type="hidden" name="id" value={d.id as string} /><Input name="recipient" placeholder="Recipient" required className="w-32 py-1 text-xs" /><Button className="min-h-0 px-2 py-1 text-xs" type="submit">Release</Button></form>
                    )}
                    {d.status === "stale" && <Badge tone="bad">Regenerate</Badge>}
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
