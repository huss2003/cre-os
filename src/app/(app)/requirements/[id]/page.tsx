import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Select, StaleBanner, Stat, Table, Td, Textarea, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import {
  addStakeholderAction, confirmRequirementAction, createOpportunityAction, createQuoteAction, quickScenarioFromQuoteAction,
  reviseQuoteAction, runShortlistAction, setOptionStatusAction, updateRequirementFieldAction,
} from "@/modules/deals/actions";
import { STAKEHOLDER_ROLES, fieldValue } from "@/modules/deals/requirements/contract";
import { getRequirementDetail } from "@/modules/deals/requirements/service";
import { EligibilityBadge, FieldStatusBadge, Flash, RequirementStatusBadge, nonce } from "@/modules/deals/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;
const show = (v: unknown) => Array.isArray(v) ? (v.every((x) => x === null || x === undefined) ? "—" : v.map((x) => x ?? "—").join(" / ")) : v === null || v === undefined || v === "" ? "—" : String(v);

export default async function RequirementDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  let d: Awaited<ReturnType<typeof getRequirementDetail>>;
  try { d = await getRequirementDetail(ctx, id); } catch (e) { if (e instanceof DealsError && e.status === 404) notFound(); throw e; }
  const r = d.requirement as Record<string, unknown> & { row_version: number; status: string; title: string };
  const org = r.organisation as { display_name?: string } | null;
  const options = (d.shortlist?.options ?? []) as Record<string, unknown>[];
  const currentQuotes = (d.quotes as Record<string, unknown>[]).filter((q) => !q.superseded_by);
  const canEdit = app.role !== "viewer";
  const today = new Date().toISOString().slice(0, 10);
  const hidden = (<><input type="hidden" name="id" value={id} /><input type="hidden" name="row_version" value={r.row_version} /><input type="hidden" name="nonce" value={nonce()} /></>);

  return (
    <div className="space-y-5">
      <PageHeader title={r.title} subtitle={<>{org?.display_name ?? "—"} · <RequirementStatusBadge status={r.status} /></>}
        actions={<><ButtonLink variant="secondary" href={`/documents?requirement=${id}`}>Documents</ButtonLink><ButtonLink variant="secondary" href={`/finance?requirement=${id}`}>Financials</ButtonLink></>} />
      <Flash sp={sp} />
      {d.pendingProposals.length > 0 && <StaleBanner>{d.pendingProposals.length} change proposal(s) to confirmed fields await approval — <Link className="underline" href="/approvals">open approvals</Link>.</StaleBanner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Mandatory known" value={`${d.completeness.percentKnown}%`} hint={`${d.completeness.mandatoryKnown}/${d.completeness.mandatoryTotal}`} />
        <Stat label="Client confirmed" value={`${d.completeness.percentConfirmed}%`} hint={`${d.completeness.mandatoryConfirmed}/${d.completeness.mandatoryTotal}`} />
        <Stat label="Shortlist" value={d.shortlist ? `v${(d.shortlist.version as { version: number }).version}` : "—"} hint={d.shortlist ? `${options.length} options stored` : "not run yet"} />
        <Stat label="Stakeholders" value={d.stakeholders.length} hint={d.stakeholderGaps[0] ?? "mapped"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Requirement contract">
          <div className="divide-y divide-line">
            {d.fields.map((f) => (
              <div key={f.key} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div><div className="font-medium">{f.label}{f.mandatory ? <span className="text-bad"> *</span> : null}</div><div className="text-ink-soft">{show(fieldValue(r, f.key))}</div></div>
                <FieldStatusBadge status={f.status} />
              </div>
            ))}
          </div>
        </Card>
        <div className="space-y-5">
          <Card title={`Questions to ask (${d.missing.length})`}>
            {d.missing.length === 0 ? <p className="text-sm text-ink-soft">Nothing open.</p> : (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {d.missing.slice(0, 15).map((q) => <li key={q.key}>{q.question} {q.reason === "estimated_needs_confirmation" ? <Badge tone="warn">confirm estimate</Badge> : q.priority === "mandatory" ? <Badge tone="bad">mandatory</Badge> : null}</li>)}
              </ol>
            )}
          </Card>
          {canEdit && (
            <Card title="Update a field">
              <form action={updateRequirementFieldAction} className="space-y-3">
                {hidden}
                <Field label="Field"><Select name="key" required defaultValue="">{[<option key="" value="">— choose —</option>, ...d.fields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.status === "client_confirmed" ? " (confirmed → needs approval)" : ""}</option>)]}</Select></Field>
                <Field label="Value" hint="Ranges (area / seats / budget): fill min · target · max below instead. Lists: comma-separated."><Input name="value" /></Field>
                <div className="grid grid-cols-3 gap-2"><Input name="v0" placeholder="min" /><Input name="v1" placeholder="target / max" /><Input name="v2" placeholder="max" /></div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Status"><Select name="status" defaultValue=""><option value="">Estimated (default)</option><option value="client_confirmed">Client confirmed</option><option value="unknown">Unknown</option></Select></Field>
                  <Field label="Only change status?"><Select name="value_mode" defaultValue="value"><option value="value">Set value</option><option value="status_only">Status only</option></Select></Field>
                </div>
                <Field label="Reason / source"><Input name="reason" placeholder="e.g. call with CFO 31 Oct" /></Field>
                <Button type="submit">Save</Button>
              </form>
            </Card>
          )}
          {canEdit && r.status !== "client_confirmed" && (
            <Card title="Client confirmation">
              {d.blockers.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              ) : (
                <form action={confirmRequirementAction} className="space-y-2">
                  {hidden}
                  <Field label="Evidence of confirmation"><Textarea name="evidence" required placeholder="Email from client dated …, or signed requirement brief" /></Field>
                  <Button type="submit">Mark client-confirmed</Button>
                </form>
              )}
            </Card>
          )}
        </div>
      </div>

      <Card title="Stakeholder map">
        {d.stakeholderGaps.length > 0 && <ul className="mb-3 space-y-1 text-sm text-warn">{d.stakeholderGaps.map((g) => <li key={g}>• {g}</li>)}</ul>}
        {d.stakeholders.length === 0 ? <p className="text-sm text-ink-soft">No stakeholders mapped yet.</p> : (
          <ul className="mb-3 divide-y divide-line text-sm">
            {(d.stakeholders as Record<string, unknown>[]).map((s) => <li key={s.id as string} className="flex justify-between py-1.5"><span>{(s.person as { full_name?: string } | null)?.full_name ?? "—"}</span><Badge>{s.role as string}</Badge></li>)}
          </ul>
        )}
        {canEdit && (
          <form action={addStakeholderAction} className="grid gap-2 sm:grid-cols-4">
            <input type="hidden" name="id" value={id} />
            <Input name="person_name" placeholder="Name" required />
            <Select name="role" defaultValue="sponsor">{STAKEHOLDER_ROLES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
            <Input name="influence_basis" placeholder="Why they matter" />
            <Button type="submit" variant="secondary">Add</Button>
          </form>
        )}
      </Card>

      <Card title="Shortlist (match-v1)" actions={canEdit ? (
        <form action={runShortlistAction}><input type="hidden" name="id" value={id} /><Button type="submit" variant="secondary">Run shortlist</Button></form>) : null}>
        {r.status !== "client_confirmed" && <StaleBanner>Requirement not client-confirmed: any shortlist is provisional.</StaleBanner>}
        {options.length === 0 ? (
          <EmptyState title="No shortlist yet">Run the shortlist after buildings, spaces and availability are imported. Spaces without a dated availability snapshot appear as “vacancy unverified”.</EmptyState>
        ) : (
          <Table head={["#", "Option", "Eligibility", "Fit", "Data", "Flags / reasons", "Status"]}>
            {options.slice(0, 40).map((o) => {
              const b = (o.score_breakdown ?? {}) as { rank?: number; label?: string; eligibility?: string; verificationNeeded?: string[]; flags?: Record<string, boolean> };
              return (
                <tr key={o.id as string}>
                  <Td>{b.rank}</Td>
                  <Td className="min-w-40">{b.label}</Td>
                  <Td><EligibilityBadge e={b.eligibility ?? "ineligible"} /></Td>
                  <Td>{String(o.fit_score ?? "—")}</Td>
                  <Td>{String(o.completeness_score ?? "—")}%</Td>
                  <Td className="max-w-md text-xs text-ink-soft">
                    {[...(o.disqualifiers as string[]), ...(b.verificationNeeded ?? []), b.flags?.quoteExpired ? "Quote expired/superseded" : null].filter(Boolean).slice(0, 4).join(" · ") || "—"}
                  </Td>
                  <Td>
                    {canEdit && b.eligibility !== "ineligible" ? (
                      <form action={setOptionStatusAction} className="flex gap-1">
                        <input type="hidden" name="id" value={id} /><input type="hidden" name="option_id" value={o.id as string} />
                        <Select name="status" defaultValue={o.option_status as string} className="min-w-28">{["proposed", "shortlisted", "visited", "rejected", "selected"].map((x) => <option key={x}>{x}</option>)}</Select>
                        <Button variant="ghost" type="submit">Set</Button>
                      </form>
                    ) : <Badge>{o.option_status as string}</Badge>}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Quotes (versioned)">
        {d.quotes.length === 0 ? <p className="mb-3 text-sm text-ink-soft">No quotes recorded. Quotes are immutable: a revision creates a new version and invalidates approvals and documents built on the old one.</p> : (
          <div className="mb-4"><Table head={["Version", "Space", "Rent", "CAM", "Valid until", "State"]}>
            {(d.quotes as Record<string, unknown>[]).map((q) => {
              const t = (q.terms_json ?? {}) as Record<string, unknown>;
              const opt = options.find((o) => o.space_id === q.space_id);
              return (
                <tr key={q.id as string}>
                  <Td>v{String(q.version)}</Td>
                  <Td>{((opt?.score_breakdown as { label?: string } | undefined)?.label) ?? (q.space_id ? String(q.space_id).slice(0, 8) : "—")}</Td>
                  <Td>{t.rent !== undefined ? `${inr(t.rent as number)} / ${t.rent_basis ?? "?"}` : "—"}</Td>
                  <Td>{t.cam_included ? "included" : t.cam_per_sf !== undefined ? inr(t.cam_per_sf as number) : "unknown"}</Td>
                  <Td>{(q.valid_until as string) ?? "none"}</Td>
                  <Td>{q.superseded_by ? <Badge>superseded</Badge> : q.valid_until && (q.valid_until as string) < today ? <Badge tone="bad">expired</Badge> : <Badge tone="ok">current</Badge>}</Td>
                </tr>
              );
            })}
          </Table></div>
        )}
        {canEdit && (
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Record a quote</summary>
            <form action={createQuoteAction} className="mt-3 grid gap-2 sm:grid-cols-3">
              <input type="hidden" name="id" value={id} />
              <Field label="Space"><Select name="space_id" defaultValue=""><option value="">— none —</option>{options.filter((o) => (o.score_breakdown as { eligibility?: string }).eligibility !== "ineligible").map((o) => <option key={o.id as string} value={o.space_id as string}>{(o.score_breakdown as { label?: string }).label}</option>)}</Select></Field>
              <Field label="Rent (₹/unit/month)"><Input name="rent" inputMode="decimal" required /></Field>
              <Field label="Rent basis"><Select name="rent_basis" defaultValue="chargeable"><option>chargeable</option><option>carpet</option><option>seat</option></Select></Field>
              <Field label="CAM ₹/SF/month"><Input name="cam_per_sf" inputMode="decimal" /></Field>
              <Field label="Escalation %"><Input name="escalation_pct" inputMode="decimal" /></Field>
              <Field label="…every (months)"><Input name="escalation_every_months" inputMode="numeric" /></Field>
              <Field label="Rent-free months"><Input name="rent_free_months" inputMode="numeric" /></Field>
              <Field label="Deposit (months)"><Input name="deposit_months" inputMode="decimal" /></Field>
              <Field label="Tenure / lock-in (months)"><div className="flex gap-1"><Input name="tenure_months" inputMode="numeric" placeholder="tenure" /><Input name="lockin_months" inputMode="numeric" placeholder="lock-in" /></div></Field>
              <Field label="GST"><Select name="gst" defaultValue=""><option value="">Not stated</option><option value="excluded">Excluded</option><option value="included">Included</option></Select></Field>
              <Field label="Valid until"><Input type="date" name="valid_until" required /></Field>
              <Field label="Source / evidence"><Input name="evidence" placeholder="Landlord email 30 Oct" /></Field>
              <div className="sm:col-span-3"><Button type="submit">Save quote v1</Button></div>
            </form>
          </details>
        )}
        {canEdit && currentQuotes.length > 0 && (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium">Revise a quote (new version)</summary>
              <form action={reviseQuoteAction} className="mt-3 grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="id" value={id} />
                <Select name="quote_id" required>{currentQuotes.map((q) => <option key={q.id as string} value={q.id as string}>v{String(q.version)} · {String((q.terms_json as Record<string, unknown>).rent ?? "")}</option>)}</Select>
                <Input name="rent" inputMode="decimal" placeholder="New rent" />
                <Input name="rent_free_months" inputMode="numeric" placeholder="Rent-free months" />
                <Input type="date" name="valid_until" />
                <Input name="evidence" placeholder="Source of revision" className="sm:col-span-2" />
                <Button type="submit" variant="secondary">Save new version</Button>
              </form>
            </details>
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium">Calculate a scenario from a quote</summary>
              <form action={quickScenarioFromQuoteAction} className="mt-3 grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="id" value={id} />
                <Select name="quote_id" required>{currentQuotes.map((q) => <option key={q.id as string} value={q.id as string}>Quote v{String(q.version)}</option>)}</Select>
                <Input name="name" placeholder="Scenario name" />
                <Field label="Base date"><Input type="date" name="base_date" required defaultValue={(r.occupation_date as string) ?? today} /></Field>
                <Field label="Horizon (months)"><Input name="horizon" defaultValue="60" inputMode="numeric" /></Field>
                <Field label="Discount rate % p.a."><Input name="discount" required inputMode="decimal" /></Field>
                <Field label="Fit-out capex ₹"><Input name="fitout" inputMode="decimal" /></Field>
                <Field label="If tenure < horizon"><Select name="after_tenure" defaultValue=""><option value="">(tenure covers horizon)</option><option value="continue_same_terms">Renew on same terms</option><option value="vacate">Vacate</option></Select></Field>
                <Field label="GST rate % (if excluded)"><Input name="gst_rate" inputMode="decimal" /></Field>
                <Button type="submit" variant="secondary">Calculate</Button>
              </form>
            </details>
          </div>
        )}
      </Card>

      <Card title="Opportunity">
        {d.opportunities.length ? (
          <ul className="space-y-1 text-sm">{(d.opportunities as Record<string, unknown>[]).map((o) => <li key={o.id as string}><Link className="text-brand underline" href={`/deals/${o.id}`}>{o.name as string}</Link> · {o.stage as string} · {o.outcome as string}</li>)}</ul>
        ) : canEdit ? (
          <form action={createOpportunityAction} className="flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="requirement_id" value={id} /><input type="hidden" name="back" value={`/requirements/${id}`} />
            <Input name="name" defaultValue={r.title} required />
            <Select name="stage" defaultValue="qualified_discussion"><option value="research">Research</option><option value="engaged">Engaged</option><option value="qualified_discussion">Qualified discussion</option></Select>
            <Button type="submit" variant="secondary">Track as opportunity</Button>
          </form>
        ) : <p className="text-sm text-ink-soft">No opportunity yet.</p>}
      </Card>

      <Card title="History">
        <ul className="space-y-1 text-xs text-ink-soft">{(d.versions as Record<string, unknown>[]).map((v) => <li key={v.version as number}>v{String(v.version)} · {new Date(v.created_at as string).toLocaleString("en-IN")} · {String(v.change_reason ?? "")}</li>)}</ul>
      </Card>
    </div>
  );
}
