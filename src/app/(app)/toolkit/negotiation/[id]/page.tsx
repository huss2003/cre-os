import { notFound } from "next/navigation";
import { Badge, Card, Field, Input, PageHeader, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { addOfferAction, packagesAction, talkingPointsAction } from "@/modules/toolkit/actions-lease";
import { loadNegotiation } from "@/modules/toolkit/lease-service";
import type { DiffStatus, PackageItem } from "@/modules/toolkit/calc/negotiation";
import { LeaseTermFields, Money, Warnings } from "../../lease/parts";
import { NonFinancialFields } from "../fields";

const TONE: Record<DiffStatus, "ok" | "bad" | "neutral" | "warn"> = { improved: "ok", worse: "bad", unchanged: "neutral", unresolved: "warn", changed: "neutral" };
const itemText = (i: PackageItem) => {
  switch (i.type) {
    case "lower_rent": return `rent −₹${i.perSf}/sf`;
    case "longer_rent_free": return `+${i.months} rent-free months`;
    case "lower_deposit": return `deposit −${i.months} months`;
    case "reduced_escalation": return `escalation −${i.pctPoints}pp`;
    case "fitout_contribution": return `fit-out contribution ${inr(i.amount)}`;
    case "extra_parking": return `+${i.slots} free parking slots`;
    case "earlier_possession": return `possession ${i.months} months earlier`;
    case "flexible_lock_in": return `lock-in −${i.months} months`;
  }
};

export default async function NegotiationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const a = await loadNegotiation({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId }, id);
  if (!a) notFound();
  const { versions } = a.inputs;
  const out = a.outputs;
  const latest = versions[versions.length - 1].terms;
  const editor = ctx.role !== "viewer";
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <PageHeader title={a.title} subtitle={`${versions.length} offer version${versions.length === 1 ? "" : "s"} · analysis v${a.current_version} · ${a.formula_version} · compared over ${out.horizonMonths} months`} />

      <Card title="Offers">
        <Table head={["Offer", "Recorded", "Rent total", "Deposit (refundable)", "Contractual expenditure", "Present value", "Costs"]}>
          {out.offers.map((o) => {
            const v = versions.find((x) => x.no === o.no);
            return <tr key={o.no}><Td className="font-medium">{o.label}</Td><Td className="text-xs text-ink-soft">{v?.createdAt.slice(0, 10)}{v?.note ? ` · ${v.note}` : ""}</Td><Td>{inr(o.rentTotal)}</Td><Td><Money x={o.depositAmount} /></Td><Td>{inr(o.contractualExpenditure)}</Td><Td>{inr(o.npv)}</Td><Td>{o.complete ? <Badge tone="ok">complete</Badge> : <Badge tone="warn" title={o.gaps.join(", ")}>incomplete</Badge>}</Td></tr>;
          })}
        </Table>
        <Warnings items={out.warnings} />
      </Card>

      {out.diffs.filter((d) => d.from !== null).reverse().map((d) => (
        <Card key={d.to} title={`Offer ${d.to} vs Offer ${d.from}`}>
          {d.financial && (
            <p className="mb-3 text-sm">
              Present value {Number(d.financial.npvChange) <= 0 ? "down" : "up"} <strong>{inr(Math.abs(Number(d.financial.npvChange)))}</strong> · rent over term {inr(d.financial.rentChange)} · deposit {d.financial.depositChange === null ? <Badge tone="warn">unknown</Badge> : inr(d.financial.depositChange)}
              {" "}<Badge tone={d.financial.better === "to" ? "ok" : d.financial.better === "from" ? "bad" : "neutral"}>{d.financial.better === "to" ? `Offer ${d.to} cheaper` : d.financial.better === "from" ? `Offer ${d.to} dearer` : "same cost"}</Badge>
            </p>
          )}
          <Table head={["Term", `Offer ${d.from}`, `Offer ${d.to}`, "Change"]}>
            {d.terms.map((t) => <tr key={t.key}><Td>{t.label}</Td><Td>{t.previous ?? "—"}</Td><Td>{t.current ?? "—"}</Td><Td><Badge tone={TONE[t.status]}>{t.status}</Badge></Td></tr>)}
          </Table>
        </Card>
      ))}

      <Card title={`Concession packages (valued against ${versions[versions.length - 1].label})`}>
        {out.packages.length ? (
          <div className="space-y-3">
            {out.packages.map((p) => (
              <div key={p.name} className="rounded-2xl border border-line p-4 text-sm">
                <p className="font-medium">{p.name} — {p.npvValue === null ? <Badge tone="warn">not a cash value</Badge> : <>worth <strong>{inr(p.npvValue)}</strong> PV to the occupier (nominal {inr(p.nominalValue)})</>}</p>
                <ul className="mt-1 list-disc pl-5 text-ink-soft">{p.itemValues.map((iv, k) => <li key={k}>{itemText(iv.item)}: {iv.npvValue === null ? "not modelled" : inr(iv.npvValue)}{iv.equivalentRentFreeMonths ? ` (≈ ${iv.equivalentRentFreeMonths} rent-free months)` : ""}{iv.note ? ` — ${iv.note}` : ""}</li>)}</ul>
                {p.notes.length ? <p className="mt-1 text-xs text-ink-soft">{p.notes.join(" · ")}</p> : null}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-ink-soft">No packages yet. Describe up to three concession packages below to see what each is worth.</p>}
        {editor && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-brand">＋ Define packages (replaces the current set; saved as a new version)</summary>
            <ActionForm action={packagesAction} className="mt-3 space-y-4">
              <input type="hidden" name="id" value={a.id} />
              {[0, 1, 2].map((k) => {
                const pk = a.inputs.packages?.[k];
                const get = (t: PackageItem["type"]) => pk?.items.find((x) => x.type === t);
                const val = (x: unknown) => (x === undefined || x === null ? "" : String(x));
                const ep = get("earlier_possession") as Extract<PackageItem, { type: "earlier_possession" }> | undefined;
                return (
                  <fieldset key={k} className="grid grid-cols-2 gap-3 rounded-2xl border border-line p-4 sm:grid-cols-3">
                    <legend className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Package {k + 1}</legend>
                    <Field label="Name"><Input name={`p${k}_name`} defaultValue={pk?.name ?? ""} /></Field>
                    <Field label="Lower rent ₹/sf"><Input name={`p${k}_rent`} inputMode="decimal" defaultValue={val((get("lower_rent") as { perSf?: unknown })?.perSf)} /></Field>
                    <Field label="Extra rent-free (mo)"><Input name={`p${k}_rf`} inputMode="numeric" defaultValue={val((get("longer_rent_free") as { months?: unknown })?.months)} /></Field>
                    <Field label="Lower deposit (mo)"><Input name={`p${k}_dep`} inputMode="decimal" defaultValue={val((get("lower_deposit") as { months?: unknown })?.months)} /></Field>
                    <Field label="Escalation −pp"><Input name={`p${k}_esc`} inputMode="decimal" defaultValue={val((get("reduced_escalation") as { pctPoints?: unknown })?.pctPoints)} /></Field>
                    <Field label="Fit-out contribution ₹"><Input name={`p${k}_fitout`} inputMode="decimal" defaultValue={val((get("fitout_contribution") as { amount?: unknown })?.amount)} /></Field>
                    <Field label="Free parking slots"><Input name={`p${k}_parking`} inputMode="numeric" defaultValue={val((get("extra_parking") as { slots?: unknown })?.slots)} /></Field>
                    <Field label="Earlier possession (mo)"><Input name={`p${k}_poss`} inputMode="numeric" defaultValue={val(ep?.months)} /></Field>
                    <Field label="Current rent ₹/month" hint="Parallel rent avoided by earlier possession. Blank = not valued."><Input name={`p${k}_parallel`} inputMode="decimal" defaultValue={val(ep?.parallelRentMonthly)} /></Field>
                    <Field label="Shorter lock-in (mo)"><Input name={`p${k}_lockin`} inputMode="numeric" defaultValue={val((get("flexible_lock_in") as { months?: unknown })?.months)} /></Field>
                  </fieldset>
                );
              })}
              <Submit>Value packages</Submit>
            </ActionForm>
          </details>
        )}
      </Card>

      <Card title="Strategy (from the data — your call, nothing is sent)">
        <dl className="space-y-3 text-sm">
          <div><dt className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Preferred outcome</dt><dd>{out.strategy.preferredOutcome}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Acceptable alternative</dt><dd>{out.strategy.acceptableAlternative ?? "—"}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Unresolved</dt><dd>{out.strategy.unresolved.length ? out.strategy.unresolved.join(", ") : "Nothing open"}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Risks</dt><dd>{out.strategy.risks.length ? <ul className="list-disc pl-5">{out.strategy.risks.map((r, i) => <li key={i}>{r}</li>)}</ul> : "None flagged"}</dd></div>
        </dl>
        {editor && (
          <ActionForm action={talkingPointsAction} className="mt-4">
            <input type="hidden" name="id" value={a.id} />
            <Submit variant="secondary">Draft talking points (optional AI wording)</Submit>
          </ActionForm>
        )}
      </Card>

      {editor && (
        <Card title={`Record Offer ${versions.length + 1}`}>
          <p className="mb-3 text-sm text-ink-soft">Pre-filled with {versions[versions.length - 1].label}. Change what the landlord changed; earlier offers stay exactly as recorded.</p>
          <ActionForm action={addOfferAction} className="space-y-4">
            <input type="hidden" name="id" value={a.id} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Discount % p.a." hint="Must match earlier offers for a fair comparison."><Input name="discount" inputMode="decimal" required defaultValue={String(latest.discountRatePct)} /></Field>
              <Field label="Note"><Input name="note" placeholder="Landlord counter after site visit" /></Field>
            </div>
            <LeaseTermFields p="o0_" def={latest} title="Financial terms" extra={<NonFinancialFields def={latest} />} />
            <Submit>Save as Offer {versions.length + 1}</Submit>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
