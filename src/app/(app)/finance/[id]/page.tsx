import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, ButtonLink, Card, Field, Input, MoreFields, PageHeader, Select, Stat, StaleBanner, Table, Td, inr } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { approveScenarioAction } from "@/modules/deals/actions";
import { approveAssumptionsAction, recalculateScenarioAction, revokeAssumptionAction } from "@/modules/deals/actions-a";
import { checkQuoteRefs, concessions, listAssumptions, runEngine } from "@/modules/deals/finance/service";
import { sensitivities, type Concession } from "@/modules/deals/finance/engine";
import { COST_ITEM_LABEL, type CostItem, type FinanceInput, type RoundingRule } from "@/modules/deals/finance/types";
import { Flash, KV } from "@/modules/deals/ui";

const fmtVal = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v).replace(/[{}"]/g, "").replace(/,/g, ", ").replace(/:/g, ": "));

export default async function ScenarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const { data: sc } = await ctx.db.from("finance_scenario").select("*").eq("id", id).maybeSingle();
  if (!sc) notFound();
  const input = sc.input_json as FinanceInput;
  const r = runEngine(input);
  const reproduces = r.outputHash === sc.output_hash;
  const quoteIssues = await checkQuoteRefs(ctx, input);
  const stored = await listAssumptions(ctx, id);
  const storedBy = new Map(stored.map((a) => [a.key, a]));
  const register = r.assumptions.map((a) => ({ ...a, row: storedBy.get(a.key) ?? null, changed: !!storedBy.get(a.key) && storedBy.get(a.key)!.value_hash !== a.valueHash }));
  const pendingAssumptions = register.filter((a) => a.row?.approval_state !== "approved" || a.changed);
  const { data: newer } = await ctx.db.from("finance_scenario").select("id, version").eq("previous_id", id).limit(5);
  const sens = (() => { try { return sensitivities(input); } catch { return []; } })();
  const drivers = [...sens].sort((a, b) => Math.abs(Number(b.npvChange)) - Math.abs(Number(a.npvChange)));
  const conc: Concession[] = [];
  if (input.rent) conc.push({ type: "rent_free", months: 1 }, { type: "rent_rate", rate: -5 });
  if (input.rent?.escalation) conc.push({ type: "escalation_pct", pct: -1 });
  conc.push({ type: "capex_support", amount: 1000000 });
  if (input.deposit && input.deposit.amount === undefined) conc.push({ type: "deposit_months", months: -1 });
  const cv = (() => { try { return concessions(input, conc); } catch { return []; } })();
  const byPeriod = r.periodTotals.map((v, p) => ({ p, v })).filter((x) => Number(x.v) !== 0);
  const t = r.totals;
  const rounding = (sc.rounding_rule as RoundingRule | null) ?? null;
  const ack = sc.gaps_acknowledged as { at?: string; gaps?: { label: string }[]; note?: string | null } | null;
  const isAdmin = hasRole(app, "admin");
  const canEdit = app.role !== "viewer";
  const unknownItems = (Object.entries(r.costStates) as [CostItem, string][]).filter(([, st]) => st === "unknown").map(([k]) => k);
  const blockers = [
    !reproduces ? "stored result no longer reproduces — recalculate" : null,
    ...quoteIssues,
    ...(pendingAssumptions.length ? [`${pendingAssumptions.length} assumption(s) not approved`] : []),
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      <PageHeader title={r.name} subtitle={<>{r.kind} · v{String(sc.version ?? 1)} · {r.horizonMonths} months from {r.baseDate} · engine {r.engineVersion} · {sc.approved_at ? <Badge tone="ok">approved</Badge> : <Badge>not approved</Badge>}</>}
        actions={<>
          {sc.requirement_id ? <ButtonLink variant="secondary" href={`/requirements/${sc.requirement_id}`}>Requirement</ButtonLink> : null}
          <ButtonLink variant="secondary" href={`/finance/compare?ids=${id}${sc.requirement_id ? `&requirement=${sc.requirement_id}` : ""}`}>Compare</ButtonLink>
        </>} />
      <Flash sp={sp} />
      {(newer ?? []).length > 0 && <StaleBanner>A newer version exists: {(newer ?? []).map((n) => <Link key={n.id} className="underline" href={`/finance/${n.id}`}>v{n.version}</Link>)}.</StaleBanner>}
      {sc.previous_id && <p className="text-sm text-ink-soft">Recalculated from <Link className="underline" href={`/finance/${sc.previous_id}`}>the previous version</Link>.</p>}
      {!reproduces && <StaleBanner>Stored result no longer reproduces with the current engine — re-run before using it.</StaleBanner>}
      {quoteIssues.length > 0 && <StaleBanner>Quote provenance: {quoteIssues.join(" · ")}</StaleBanner>}
      {!r.complete && (
        <StaleBanner>
          <strong>Incomplete — unknown costs are not zero.</strong> Totals below cover known items only and exclude: {r.gaps.map((g) => g.label).join(", ")}.
          {ack ? ` Approved with these gaps acknowledged on ${new Date(ack.at ?? "").toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}${ack.note ? ` (“${ack.note}”)` : ""}.` : " Fill them in, mark them none, or acknowledge them explicitly when approving."}
        </StaleBanner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={r.complete ? "NPV" : "NPV — known items only"} value={inr(t.npv, { compact: true })} hint={`monthly rate ${r.monthlyDiscountRate}`} />
        <Stat label={r.complete ? "Nominal TCO" : "TCO — known items only"} value={inr(t.nominalTco, { compact: true })} />
        <Stat label={r.complete ? "Equivalent monthly" : "Equiv. monthly — partial"} value={inr(t.equivalentMonthly, { compact: true })} />
        <Stat label="Peak cumulative outflow" value={inr(t.peakCumulativeOutflow, { compact: true })} hint={`peak month ${t.peakMonthlyOutflowPeriod}`} />
      </div>
      <p className="text-sm font-medium">{r.totalsLabel}</p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Cost inputs (three-state)">
          <Table head={["Cost", "State"]}>
            {(Object.entries(r.costStates) as [CostItem, string][]).map(([k, st]) => (
              <tr key={k}><Td>{COST_ITEM_LABEL[k]}</Td><Td>{st === "known" ? <Badge tone="ok">known</Badge> : st === "none" ? <Badge>none / included</Badge> : <Badge tone="warn">unknown — gap</Badge>}</Td></tr>
            ))}
            {r.gaps.some((g) => g.item === "gst") && <tr><Td>GST</Td><Td><Badge tone="warn">rate unknown — gap</Badge></Td></tr>}
          </Table>
        </Card>
        <Card title="Unit costs & reproducibility">
          <KV items={[["₹/chargeable SF/month", t.perChargeableSfMonth ? inr(t.perChargeableSfMonth) : "—"], ["₹/carpet SF/month", t.perCarpetSfMonth ? inr(t.perCarpetSfMonth) : "—"], ["₹/planned seat/month", t.perPlannedSeatMonth ? inr(t.perPlannedSeatMonth) : "—"], ["Effective rent ₹/SF/month", t.effectiveRentPerSfMonth ? inr(t.effectiveRentPerSfMonth) : "—"], ["Financing interest", t.financingInterestTotal ? inr(t.financingInterestTotal) : "—"], ["Output hash", r.outputHash.slice(0, 16)]]} />
          <div className="mt-3 text-xs text-ink-soft">
            <div className="font-medium text-ink">Rounding rule {rounding ? "(stored with this result)" : "(not stored on this legacy version — engine rule shown; recalculate to store it)"}</div>
            <ul className="mt-1 list-disc pl-4">{Object.entries(rounding ?? r.roundingRule).map(([k, v]) => <li key={k}><span className="font-medium">{k}</span>: {String(v)}</li>)}</ul>
          </div>
          {r.warnings.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-warn">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </Card>
      </div>

      <Card title={`Assumptions register (${register.length - pendingAssumptions.length}/${register.length} approved)`}>
        {stored.length === 0 && <p className="mb-2 text-sm text-warn">This version was saved before the assumptions register existed: recalculate it to register and approve its assumptions.</p>}
        <form action={approveAssumptionsAction} className="space-y-2">
          <input type="hidden" name="id" value={id} />
          <Table head={["", "Assumption", "Value", "Source", "Approval"]}>
            {register.map((a) => (
              <tr key={a.key}>
                <Td>{isAdmin && a.row && a.row.approval_state !== "approved" && !a.changed ? <input type="checkbox" name="key" value={a.key} defaultChecked aria-label={`approve ${a.label}`} /> : null}</Td>
                <Td className="font-medium">{a.label}</Td>
                <Td className="max-w-xs text-xs">{fmtVal(a.value)}</Td>
                <Td className="text-xs text-ink-soft">{a.source}</Td>
                <Td>{!a.row ? <Badge tone="warn">not registered</Badge> : a.changed ? <Badge tone="bad">value changed — re-approve</Badge> : a.row.approval_state === "approved"
                  ? <span className="flex flex-wrap items-center gap-1"><Badge tone="ok" title={a.row.approval_note ?? undefined}>approved {a.row.approved_at ? new Date(a.row.approved_at).toLocaleDateString("en-IN") : ""}</Badge></span>
                  : <Badge tone="warn">pending</Badge>}</Td>
              </tr>
            ))}
          </Table>
          {isAdmin && register.some((a) => a.row && a.row.approval_state !== "approved" && !a.changed) && (
            <div className="flex flex-col gap-2 sm:flex-row"><Input name="note" placeholder="Approval note / basis (optional)" /><Button type="submit" variant="secondary">Approve selected assumptions</Button></div>
          )}
        </form>
        {isAdmin && stored.some((a) => a.approval_state === "approved") && (
          <form action={revokeAssumptionAction} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="id" value={id} />
            <Select name="key" aria-label="assumption to revoke">{stored.filter((a) => a.approval_state === "approved").map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</Select>
            <Input name="note" placeholder="Why" />
            <Button type="submit" variant="ghost">Revoke approval</Button>
          </form>
        )}
      </Card>

      <Card title="Approval">
        {sc.approved_at ? <p className="text-sm">Approved {new Date(sc.approved_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}{ack ? ` with acknowledged gaps: ${(ack.gaps ?? []).map((g) => g.label).join(", ")}` : ""}.</p> : (
          <>
            {blockers.length > 0 && <ul className="mb-2 list-disc pl-5 text-sm text-warn">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
            {isAdmin ? (
              <form action={approveScenarioAction} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                {!r.complete && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledge_gaps" className="mt-1" /> <span>I acknowledge these costs are unknown and excluded from the totals: <strong>{r.gaps.map((g) => g.label).join(", ")}</strong>. The acknowledgement is recorded with the approval.</span></label>}
                <Input name="note" placeholder="Approval note (optional)" />
                <Button type="submit" disabled={blockers.length > 0}>Approve scenario</Button>
              </form>
            ) : <p className="text-sm text-ink-soft">An admin approves scenarios once every assumption is approved and unknown costs are resolved or acknowledged.</p>}
          </>
        )}
      </Card>

      {canEdit && (
        <Card title="Recalculate as a new version">
          <p className="mb-3 text-xs text-ink-soft">Leave blank to keep the current value.</p>
          <form action={recalculateScenarioAction} className="max-w-md space-y-4">
            <input type="hidden" name="id" value={id} />
            <div className="space-y-4">
              <Field label={`Discount rate % (now ${String(input.annualDiscountRatePct)})`}><Input name="discount" inputMode="decimal" /></Field>
              <Field label="Discount-rate source"><Input name="discount_source" placeholder="e.g. client WACC" /></Field>
              {input.rent && <Field label={`Escalation % / every (now ${input.rent.escalation ? `${input.rent.escalation.pct}/${input.rent.escalation.everyMonths}` : "none"})`}><div className="grid grid-cols-2 gap-2"><Input name="esc_pct" inputMode="decimal" /><Input name="esc_every" inputMode="numeric" /></div></Field>}
              {input.rent && <Field label={`Rent-free months (now ${input.rent.rentFreeMonths ?? 0})`}><Input name="rent_free" inputMode="numeric" /></Field>}
              {input.taxes?.treatment === "excluded" && <Field label={`GST rate % (now ${input.taxes.gstRatePct ?? "unknown"})`}><Input name="gst_rate" inputMode="decimal" /></Field>}
            </div>
            {unknownItems.length > 0 && (
              <MoreFields label={`Unknown costs (${unknownItems.length})`}>
                {unknownItems.map((item) => (
                  <fieldset key={item} className="space-y-1 rounded-lg border border-line p-2">
                    <legend className="px-1 text-sm font-medium">{COST_ITEM_LABEL[item]} — unknown</legend>
                    <Select name={`${item}_state`} defaultValue="" aria-label={`${COST_ITEM_LABEL[item]} state`}><option value="">leave unknown</option><option value="none">none / included</option><option value="amount">amount:</option></Select>
                    <div className="flex gap-1">
                      {item === "cam" && <Input name="cam_rate" inputMode="decimal" placeholder="₹/SF/month" />}
                      {item === "parking" && <><Input name="parking_slots" inputMode="numeric" placeholder="slots" /><Input name="parking_rate" inputMode="decimal" placeholder="₹/slot" /></>}
                      {item === "deposit" && <Input name="deposit_months" inputMode="decimal" placeholder="months of rent" />}
                      {item === "fitout" && <Input name="fitout" inputMode="decimal" placeholder="₹ total" />}
                      {item === "opex" && <Input name="opex_monthly" inputMode="decimal" placeholder="₹/month" />}
                      {item === "reinstatement" && <Input name="reinstatement" inputMode="decimal" placeholder="₹" />}
                      {item === "rent" && <span className="text-xs text-ink-soft">enter rent via a new scenario</span>}
                    </div>
                  </fieldset>
                ))}
              </MoreFields>
            )}
            {unknownItems.length > 0 && <Field label="Source for “none” answers"><Input name="none_source" placeholder="e.g. landlord confirmed CAM included — email 30 Oct" /></Field>}
            <Button type="submit" variant="secondary">Recalculate new version</Button>
          </form>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="By category (nominal)">
          <Table head={["Category", "Total"]}>{Object.entries(r.categoryTotals).map(([k, v]) => <tr key={k}><Td>{k.replaceAll("_", " ")}</Td><Td>{inr(v)}</Td></tr>)}</Table>
        </Card>
        <Card title="What drives the result (NPV sensitivities, largest first)">
          <Table head={["Change", "NPV", "Δ NPV"]}>{drivers.map((s) => <tr key={s.label}><Td>{s.label}</Td><Td>{inr(s.npv)}</Td><Td>{inr(s.npvChange)}</Td></tr>)}</Table>
        </Card>
      </div>
      {cv.length > 0 && (
        <Card title="Concession equivalence (value to occupier)">
          <Table head={["Concession", "NPV value", "≈ rent reduction ₹/unit/month", "≈ rent-free months"]}>
            {cv.map((c, i) => <tr key={i}><Td>{c.concession.type.replaceAll("_", " ")} {JSON.stringify(Object.fromEntries(Object.entries(c.concession).filter(([k]) => k !== "type")))}</Td><Td>{inr(c.npvValue)}</Td><Td>{c.equivalentRateReduction ?? "—"}</Td><Td>{c.equivalentRentFreeMonths ?? "—"}</Td></tr>)}
          </Table>
        </Card>
      )}
      <Card title="Monthly cash flow (non-zero periods)">
        <Table head={["Period", "Date", "Total"]}>{byPeriod.slice(0, 120).map((x) => <tr key={x.p}><Td>{x.p}</Td><Td>{r.cashflows.find((c) => c.period === x.p)?.date}</Td><Td>{inr(x.v)}</Td></tr>)}</Table>
      </Card>
    </div>
  );
}
