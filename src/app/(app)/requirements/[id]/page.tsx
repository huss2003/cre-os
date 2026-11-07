import { FOCUS_MODE } from "@/lib/nav";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Select, StaleBanner, Stat, Table, Td, Textarea, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { LinkedAdd, LinkedRows } from "@/modules/admin/ui/linked";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import {
  addStakeholderAction, confirmRequirementAction, createOpportunityAction, createQuoteAction, quickScenarioFromQuoteAction,
  reviseQuoteAction, runShortlistAction, setOptionStatusAction, updateRequirementFieldAction,
} from "@/modules/deals/actions";
import { saveMatchingConfigAction } from "@/modules/deals/actions-a";
import { CRITERIA, DEFAULT_WEIGHTS, effectiveWeights } from "@/modules/deals/matching/match";
import { STAKEHOLDER_ROLES, fieldValue, type RequirementConstraints, type RequirementRow } from "@/modules/deals/requirements/contract";
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
  // Existing people for the stakeholder picker, labelled with current employer so same-name people are distinguishable.
  const [{ data: ppl }, { data: emps }] = canEdit ? await Promise.all([
    app.db.from("person").select("id, full_name").eq("workspace_id", app.workspaceId).is("archived_at", null).order("full_name").limit(500),
    app.db.from("employment").select("person_id, title, organisation:org_id(display_name)").eq("workspace_id", app.workspaceId).eq("is_current", true).is("archived_at", null).limit(2000),
  ]) : [{ data: [] }, { data: [] }];
  const empBy = new Map(((emps ?? []) as unknown as { person_id: string; title: string | null; organisation: { display_name: string } | null }[]).map((e) => [e.person_id, `${e.title ?? "role ?"} @ ${e.organisation?.display_name ?? "?"}`]));
  const people = ((ppl ?? []) as { id: string; full_name: string }[]).map((p) => ({ id: p.id, label: `${p.full_name}${empBy.get(p.id) ? ` — ${empBy.get(p.id)}` : ""} · ${p.id.slice(0, 4)}` }));
  const today = new Date().toISOString().slice(0, 10);
  const hidden = (<><input type="hidden" name="id" value={id} /><input type="hidden" name="row_version" value={r.row_version} /><input type="hidden" name="nonce" value={nonce()} /></>);
  const geoName = (gid: string) => d.geographies.find((g) => g.id === gid)?.name ?? `unknown (${gid.slice(0, 8)})`;
  const display = (key: string, kind: string) => {
    const v = fieldValue(r, key);
    if (kind === "geo_list") return Array.isArray(v) && v.length ? (v as string[]).map(geoName).join(", ") : "—";
    return show(v);
  };
  const cons = (r.constraints ?? {}) as RequirementConstraints;
  const rs = cons.required_specs ?? {};
  const hf = { budget_ceiling: !!cons.hard_filters?.budget_ceiling, latest_occupation: !!cons.hard_filters?.latest_occupation, preferred_only: !!cons.hard_filters?.preferred_only };
  const weights = effectiveWeights(r as RequirementRow);
  const catchText = (cons.catchments ?? []).map((c) => [c.label, c.lat, c.lon, c.weight].filter((x) => x !== undefined).join(", ")).join("\n");
  const openTasks = d.tasks.filter((t) => t.status === "open" || t.status === "snoozed" || t.status === "stale");
  const specVal = (k: string) => { const v = (rs as Record<string, unknown>)[k]; return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v); };

  return (
    <div className="space-y-5">
      <PageHeader title={r.title} subtitle={<>{org?.display_name ?? "—"} · <RequirementStatusBadge status={r.status} /></>}
        actions={FOCUS_MODE ? null : <><ButtonLink variant="secondary" href={`/documents?requirement=${id}`}>Documents</ButtonLink><ButtonLink variant="secondary" href={`/finance?requirement=${id}`}>Financials</ButtonLink></>} />
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
                <div><div className="font-medium">{f.label}{f.mandatory ? <span className="text-bad"> *</span> : null}</div><div className="text-ink-soft">{display(f.key, f.kind)}</div></div>
                <FieldStatusBadge status={f.status} />
              </div>
            ))}
          </div>
        </Card>
        <div className="space-y-5">
          <Card title={`Questions to ask (${d.missing.length})`}>
            {d.missing.length === 0 ? <p className="text-sm text-ink-soft">Nothing open.</p> : (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {d.missing.slice(0, 15).map((q) => <li key={q.key}>{q.question} {q.reason === "estimated_needs_confirmation" ? <Badge tone="warn">confirm with client</Badge> : q.priority === "mandatory" ? <Badge tone="bad">mandatory</Badge> : null}</li>)}
              </ol>
            )}
            <p className="mt-2 text-xs text-ink-soft">Mandatory questions become follow-up tasks automatically and close as answers are confirmed — {openTasks.filter((t) => t.source === "deals.requirement_question").length} open.{FOCUS_MODE ? null : <> <Link className="underline" href="/tasks">Tasks</Link></>}</p>
          </Card>
          {canEdit && (
            <Card title="Update a field">
              <form action={updateRequirementFieldAction} className="space-y-3">
                {hidden}
                <Field label="Field"><Select name="key" required defaultValue="">{[<option key="" value="">— choose —</option>, ...d.fields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.status === "client_confirmed" ? " (confirmed → needs approval)" : ""}</option>)]}</Select></Field>
                <Field label="Value" hint="Ranges (area / seats / budget): fill min · target · max below instead. Lists and locations: comma-separated names. Power / parking / transit text (e.g. “500 kVA”, “40 cars, 120 two-wheelers”, “within 1 km of metro”) also sets the matching spec."><Input name="value" /></Field>
                <div className="grid grid-cols-3 gap-2"><Input name="v0" placeholder="min" /><Input name="v1" placeholder="target / max" /><Input name="v2" placeholder="max" /></div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Status"><Select name="status" defaultValue=""><option value="">Estimated (default)</option><option value="reported">Reported (second-hand)</option><option value="client_confirmed">Client-confirmed</option><option value="unknown">Unknown</option></Select></Field>
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

      <Card title="Locations & required features">
        <LinkedRows table="requirement_location" hostColumn="requirement_id" hostId={id} backPath={`/requirements/${id}`} empty="No location preferences yet." cols={[{ key: "geography_id" }, { key: "preference" }]} joins={{ geography_id: { table: "geography", label: "name" } }} />
        <LinkedAdd kind="requirement_location" hostId={id} backPath={`/requirements/${id}`} />
        <div className="mt-3" />
        <LinkedRows table="requirement_feature" hostColumn="requirement_id" hostId={id} backPath={`/requirements/${id}`} empty="No required features yet." cols={[{ key: "feature_key" }, { key: "operator" }, { key: "value_text" }, { key: "value_num", fmt: "num" }, { key: "unit" }, { key: "is_hard_constraint", label: "hard:", fmt: "bool" }]} />
        <LinkedAdd kind="requirement_feature" hostId={id} backPath={`/requirements/${id}`} />
      </Card>

      <Card title={`Hard constraints (${d.hardConstraints.length})`}>
        <p className="mb-2 text-xs text-ink-soft">Applied as eligibility filters before any ranking — a high score can never override them. Missing building data under a constraint means “needs verification”, never a match.</p>
        {d.hardConstraints.length === 0 ? <p className="text-sm text-ink-soft">No hard constraints yet. Set area, excluded locations, or the specs below (power, parking, metro, certifications, fit-out).</p> : (
          <ul className="divide-y divide-line text-sm">
            {d.hardConstraints.map((h) => (
              <li key={h.key} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
                <div><span className="font-medium">{h.label}</span> <span className="text-ink-soft">{h.value}</span><div className="text-xs text-ink-soft">{h.source}</div></div>
                <FieldStatusBadge status={h.status} />
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <details className="mt-3 rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Edit matching configuration (specs, hard filters, weights, catchments)</summary>
            <form action={saveMatchingConfigAction} className="mt-3 space-y-4">
              {hidden}
              {r.status === "client_confirmed" && <p className="text-xs text-warn">Client-confirmed requirement: spec and hard-filter changes are submitted for approval; weights and catchments apply directly.</p>}
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Min power (kVA)"><Input name="spec_min_power_kva" inputMode="decimal" defaultValue={specVal("min_power_kva")} /></Field>
                <Field label="Min car parks"><Input name="spec_min_car_parks" inputMode="numeric" defaultValue={specVal("min_car_parks")} /></Field>
                <Field label="Min two-wheeler parks"><Input name="spec_min_two_wheeler_parks" inputMode="numeric" defaultValue={specVal("min_two_wheeler_parks")} /></Field>
                <Field label="Max metro distance (km)"><Input name="spec_max_metro_km" inputMode="decimal" defaultValue={specVal("max_metro_km")} /></Field>
                <Field label="Certifications (any of)" hint="comma-separated, e.g. LEED Gold, IGBC"><Input name="spec_certifications" defaultValue={specVal("certifications")} /></Field>
                <Field label="Fit-out basis" hint="bare, warm_shell, fitted, managed"><Input name="spec_fitout_basis" defaultValue={specVal("fitout_basis")} /></Field>
              </div>
              {["min_power_kva", "min_car_parks", "min_two_wheeler_parks", "max_metro_km", "certifications", "fitout_basis"].map((k) => <input key={k} type="hidden" name={`orig_spec_${k}`} value={specVal(k)} />)}
              <input type="hidden" name="orig_spec_operating_24x7" value={String(!!rs.operating_24x7)} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="spec_operating_24x7" defaultChecked={!!rs.operating_24x7} /> 24×7 operations required</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="reset_derived" /> Reset specs to what the power / parking / transit / certification answers say</label>
              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Optional hard filters (off = scored only)</legend>
                <input type="hidden" name="orig_hf" value={JSON.stringify(hf)} />
                <label className="flex items-center gap-2"><input type="checkbox" name="hf_budget_ceiling" defaultChecked={hf.budget_ceiling} /> Exclude options above the budget ceiling</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="hf_latest_occupation" defaultChecked={hf.latest_occupation} /> Exclude options not available by the occupation date</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="hf_preferred_only" defaultChecked={hf.preferred_only} /> Preferred locations only</label>
              </fieldset>
              <div>
                <div className="mb-1 text-sm font-medium">Criterion weights (blank = default)</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  {CRITERIA.map((c) => {
                    const cur = cons.weights?.[c];
                    return (
                      <Field key={c} label={`${c} (${weights[c]})`}>
                        <Input name={`w_${c}`} inputMode="decimal" placeholder={String(DEFAULT_WEIGHTS[c])} defaultValue={cur === undefined ? "" : String(cur)} />
                        <input type="hidden" name={`orig_w_${c}`} value={cur === undefined ? "" : String(cur)} />
                      </Field>
                    );
                  })}
                </div>
              </div>
              <Field label="Catchment points" hint="One per line: label, latitude, longitude[, weight] — e.g. “Hinjewadi staff, 18.5912, 73.7389, 2”">
                <Textarea name="catchments" rows={3} defaultValue={catchText} />
              </Field>
              <input type="hidden" name="orig_catchments" value={catchText} />
              <Field label="Reason / source"><Input name="reason" placeholder="e.g. CFO call — 600 kVA confirmed" /></Field>
              <Button type="submit">Save matching configuration</Button>
            </form>
          </details>
        )}
      </Card>

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
            <label className="sr-only" htmlFor="sh-person">Existing person</label>
            <Select id="sh-person" name="person_id" defaultValue=""><option value="">— existing person —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
            <label className="sr-only" htmlFor="sh-name">Or new person name</label>
            <Input id="sh-name" name="person_name" placeholder="…or new person name" />
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
          <Table head={["#", "Option", "Eligibility", "Fit score", "Data completeness", "Why / flags", "Status"]}>
            {options.slice(0, 40).map((o) => {
              const b = (o.score_breakdown ?? {}) as { rank?: number; label?: string; eligibility?: string; verificationNeeded?: string[]; qualifies?: string[]; flags?: Record<string, boolean>;
                criteria?: Record<string, { weight: number; status: string; score: number | null; detail: string }> };
              return (
                <tr key={o.id as string}>
                  <Td>{b.rank}</Td>
                  <Td className="min-w-40">{b.label}</Td>
                  <Td><EligibilityBadge e={b.eligibility ?? "ineligible"} /></Td>
                  <Td>{String(o.fit_score ?? "—")}</Td>
                  <Td>{String(o.completeness_score ?? "—")}%</Td>
                  <Td className="max-w-md text-xs text-ink-soft">
                    {(b.flags?.availabilityStale || b.flags?.vacancyUnverified) && <div className="mb-1 font-medium text-warn">{b.flags?.availabilityStale ? "Stale availability" : ""}{b.flags?.availabilityStale && b.flags?.vacancyUnverified ? " · " : ""}{b.flags?.vacancyUnverified ? "Vacancy unverified" : ""}</div>}
                    {[...(o.disqualifiers as string[]), ...(b.verificationNeeded ?? []), b.flags?.quoteExpired ? "Quote expired/superseded" : null].filter(Boolean).slice(0, 4).join(" · ") || "—"}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-brand">Why it {b.eligibility === "ineligible" ? "fails" : "qualifies"}</summary>
                      {(b.qualifies ?? []).length > 0 && <ul className="mt-1 list-disc pl-4">{(b.qualifies ?? []).map((q) => <li key={q}>{q}</li>)}</ul>}
                      <ul className="mt-1 space-y-0.5">
                        {Object.entries(b.criteria ?? {}).map(([k, c]) => (
                          <li key={k}><span className="font-medium">{k}</span> · w{c.weight} · {c.status === "scored" ? `${Math.round((c.score ?? 0) * 100)}%` : c.status === "unknown" ? "unknown (scores 0)" : "n/a"} — {c.detail}</li>
                        ))}
                      </ul>
                      <p className="mt-1">Fit and data completeness are separate: data completeness {String(o.completeness_score ?? "—")}% says how much of this option is known, not how well it fits.</p>
                    </details>
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

      <Card title={`Follow-up & verification tasks (${openTasks.length} open)`} actions={FOCUS_MODE ? null : <ButtonLink variant="ghost" href="/tasks">All tasks</ButtonLink>}>
        {d.tasks.length === 0 ? <p className="text-sm text-ink-soft">None yet. Missing mandatory answers and shortlist verification items create tasks here automatically (deduped).</p> : (
          <ul className="divide-y divide-line text-sm">
            {d.tasks.slice(0, 30).map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2 py-1.5">
                <span className={t.status === "done" ? "text-ink-soft line-through" : ""}>{t.title}{t.completion_evidence ? <span className="block text-xs text-ink-soft no-underline">{t.completion_evidence}</span> : null}</span>
                <Badge tone={t.status === "done" ? "ok" : t.status === "open" ? "warn" : "neutral"}>{t.status}</Badge>
              </li>
            ))}
          </ul>
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
                <Field label="Fit-out capex ₹" hint="blank = unknown (a gap, not zero)"><div className="flex gap-1"><Input name="fitout" inputMode="decimal" /><Select name="fitout_state" defaultValue="" aria-label="fit-out state"><option value="">amount / unknown</option><option value="none">none (fitted)</option></Select></div></Field>
                <Field label="Parking slots" hint="uses the quote's ₹/slot; blank = unknown"><div className="flex gap-1"><Input name="parking_slots" inputMode="numeric" /><Select name="parking_state" defaultValue="" aria-label="parking state"><option value="">count / unknown</option><option value="none">none needed</option></Select></div></Field>
                <Field label="Other opex ₹/month" hint="blank = unknown"><div className="flex gap-1"><Input name="opex_monthly" inputMode="decimal" /><Select name="opex_state" defaultValue="" aria-label="opex state"><option value="">amount / unknown</option><option value="none">none</option></Select></div></Field>
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
        <ul className="space-y-1 text-xs text-ink-soft">{(d.versions as Record<string, unknown>[]).map((v) => <li key={v.version as number}>v{String(v.version)} · {new Date(v.created_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {String(v.change_reason ?? "")}</li>)}</ul>
      </Card>
    </div>
  );
}
