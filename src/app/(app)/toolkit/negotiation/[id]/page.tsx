import { notFound } from "next/navigation";
import { Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { addOfferAction, packagesAction, talkingPointsAction } from "@/modules/toolkit/actions-lease";
import { loadNegotiation } from "@/modules/toolkit/lease-service";
import type { PackageItem } from "@/modules/toolkit/calc/negotiation";
import { FormSection, Legend, MissingNote, Readout, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { BlankHint, Delta, DiffPill, H, In, Panel, StickyBar } from "@/modules/toolkit/ui/lease/shared";
import { NothingSent } from "@/modules/toolkit/ui/lease/negotiation";
import { LeaseTermFields, Money, Warnings } from "../../lease/parts";
import { NonFinancialFields } from "../fields";

const STEPS = ["Record Offer 1", "Add each counter-offer", "See what changed", "Value concessions & plan"];
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
  const step = out.packages.length ? 3 : versions.length > 1 ? 2 : 1;
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <ToolHeader eyebrow="Negotiation" title={a.title} back={{ href: "/toolkit/negotiation", label: "All negotiations" }} purpose={`${versions.length} offer version${versions.length === 1 ? "" : "s"} · analysis v${a.current_version} · ${a.formula_version} · all offers compared over ${out.horizonMonths} months`} steps={STEPS} current={step} />
      <NothingSent />
      <Legend />

      <div data-tour="nego-offers" className="space-y-3">
        <H sub="Each landlord offer is kept exactly as recorded. Oldest first.">Offer timeline</H>
        <ol className="flex snap-x gap-3 overflow-x-auto pb-2">
          {out.offers.map((o, i) => {
            const v = versions.find((x) => x.no === o.no);
            return (
              <li key={o.no} className="flex min-w-[260px] flex-1 snap-start items-stretch gap-2">
                <div className={`flex-1 space-y-3 rounded-xl border-2 p-4 ${i === out.offers.length - 1 ? "border-brand/50 bg-brand-soft/30" : "border-line bg-surface"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="font-bold">{o.label}{i === out.offers.length - 1 ? <span className="ml-2 text-xs font-medium text-brand">latest</span> : null}</p><p className="text-xs text-ink-soft">{v?.createdAt.slice(0, 10)}{v?.note ? ` · ${v.note}` : ""}</p></div>
                    {o.complete ? <Status s="ready" label="Complete" /> : <Status s="needs_info" label="Incomplete" />}
                  </div>
                  <Readout label="Present value" value={inr(o.npv)} />
                  <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                    <dt className="text-ink-soft">Rent total</dt><dd className="text-right tabular-nums">{inr(o.rentTotal)}</dd>
                    <dt className="text-ink-soft">Contractual cost</dt><dd className="text-right tabular-nums">{inr(o.contractualExpenditure)}</dd>
                    <dt className="text-ink-soft">Deposit <span className="text-emerald-800">(↺ refundable)</span></dt><dd className="text-right tabular-nums"><Money x={o.depositAmount} /></dd>
                  </dl>
                  {!o.complete && o.gaps.length ? <p className="text-xs text-amber-900"><span aria-hidden>! </span>Missing: {o.gaps.join(", ")}</p> : null}
                </div>
                {i < out.offers.length - 1 ? <span aria-hidden className="self-center text-xl text-ink-soft">→</span> : null}
              </li>
            );
          })}
        </ol>
        <Warnings items={out.warnings} />
      </div>

      {out.diffs.filter((d) => d.from !== null).reverse().map((d) => (
        <Panel key={d.to}>
          <H sub="Term-by-term change. Pills show direction for the occupier.">{`What changed: Offer ${d.from} → Offer ${d.to}`}</H>
          {d.financial && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Readout emphasis label="Present value change" value={<Delta x={d.financial.npvChange} />} sub={d.financial.better === "to" ? `Offer ${d.to} is cheaper` : d.financial.better === "from" ? `Offer ${d.to} is dearer` : "same cost"} />
              <Readout label="Rent over term" value={<Delta x={d.financial.rentChange} />} />
              <Readout label="Deposit (refundable)" value={d.financial.depositChange === null ? "—" : inr(d.financial.depositChange)} unknown={d.financial.depositChange === null} />
            </div>
          )}
          <div className="overflow-x-auto">
            <Table head={["Term", `Offer ${d.from}`, `Offer ${d.to}`, "Change"]}>
              {d.terms.map((t) => <tr key={t.key}><Td className="font-medium">{t.label}</Td><Td>{t.previous ?? "—"}</Td><Td>{t.current ?? "—"}</Td><Td><DiffPill s={t.status} /></Td></tr>)}
            </Table>
          </div>
        </Panel>
      ))}

      <Panel>
        <H sub={`What each package is worth to the occupier, valued against ${versions[versions.length - 1].label}.`}>Concession packages</H>
        {out.packages.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {out.packages.map((p) => (
              <article key={p.name} className="space-y-3 rounded-xl border border-line bg-white p-4 text-sm">
                <p className="font-bold">{p.name}</p>
                <Readout emphasis label="Worth to occupier (PV)" value={p.npvValue === null ? "—" : inr(p.npvValue)} unknown={p.npvValue === null} sub={p.npvValue === null ? "not a cash value" : `nominal ${inr(p.nominalValue)}`} />
                <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">{p.itemValues.map((iv, k) => <li key={k}>{itemText(iv.item)}: {iv.npvValue === null ? "not modelled" : inr(iv.npvValue)}{iv.equivalentRentFreeMonths ? ` (≈ ${iv.equivalentRentFreeMonths} rent-free months)` : ""}{iv.note ? ` — ${iv.note}` : ""}</li>)}</ul>
                {p.notes.length ? <p className="text-xs text-ink-soft">{p.notes.join(" · ")}</p> : null}
              </article>
            ))}
          </div>
        ) : <p className="rounded-xl border-2 border-dashed border-slate-300 px-4 py-6 text-center text-sm text-ink-soft">No packages yet. Use “Define packages” below to describe up to three concession packages and see what each is worth.</p>}
        {editor && (
          <details className="group">
            <summary className={`${btn.secondary} list-none`}><span aria-hidden>＋</span> Define packages <span className="font-normal text-ink-soft">(replaces the current set; saves a new version)</span></summary>
            <ActionForm action={packagesAction} className="mt-4 space-y-4">
              <input type="hidden" name="id" value={a.id} />
              <p className="text-sm text-ink-soft">Fill only the concessions in each package. Blank = not part of this package.</p>
              {[0, 1, 2].map((k) => {
                const pk = a.inputs.packages?.[k];
                const get = (t: PackageItem["type"]) => pk?.items.find((x) => x.type === t);
                const val = (x: unknown) => (x === undefined || x === null ? "" : String(x));
                const ep = get("earlier_possession") as Extract<PackageItem, { type: "earlier_possession" }> | undefined;
                return (
                  <FormSection key={k} title={`Package ${k + 1}`} defaultOpen={k === 0 || !!pk}>
                    <In label="Package name" name={`p${k}_name`} defaultValue={pk?.name ?? ""} />
                    <In label="Lower rent by" unit="₹/sf/month" name={`p${k}_rent`} inputMode="decimal" defaultValue={val((get("lower_rent") as { perSf?: unknown })?.perSf)} />
                    <In label="Extra rent-free" unit="months" name={`p${k}_rf`} inputMode="numeric" defaultValue={val((get("longer_rent_free") as { months?: unknown })?.months)} />
                    <In label="Lower deposit by" unit="months" name={`p${k}_dep`} inputMode="decimal" defaultValue={val((get("lower_deposit") as { months?: unknown })?.months)} />
                    <In label="Lower escalation by" unit="% points" name={`p${k}_esc`} inputMode="decimal" defaultValue={val((get("reduced_escalation") as { pctPoints?: unknown })?.pctPoints)} />
                    <In label="Fit-out contribution" unit="₹" name={`p${k}_fitout`} inputMode="decimal" defaultValue={val((get("fitout_contribution") as { amount?: unknown })?.amount)} />
                    <In label="Free parking" unit="slots" name={`p${k}_parking`} inputMode="numeric" defaultValue={val((get("extra_parking") as { slots?: unknown })?.slots)} />
                    <In label="Earlier possession" unit="months" name={`p${k}_poss`} inputMode="numeric" defaultValue={val(ep?.months)} />
                    <In label="Current rent (parallel)" unit="₹/month" name={`p${k}_parallel`} inputMode="decimal" defaultValue={val(ep?.parallelRentMonthly)} hint="Rent avoided by earlier possession. Blank = not valued." />
                    <In label="Shorter lock-in" unit="months" name={`p${k}_lockin`} inputMode="numeric" defaultValue={val((get("flexible_lock_in") as { months?: unknown })?.months)} />
                  </FormSection>
                );
              })}
              <Submit>Value packages</Submit>
            </ActionForm>
          </details>
        )}
      </Panel>

      <Panel>
        <H sub="A reading of the numbers above — your call. Nothing is sent.">Strategy</H>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-emerald-50 p-4 text-sm"><p className="font-semibold text-emerald-900"><span aria-hidden>★ </span>Preferred outcome</p><p className="mt-1">{out.strategy.preferredOutcome}</p></div>
          <div className="rounded-xl bg-canvas p-4 text-sm"><p className="font-semibold"><span aria-hidden>≈ </span>Acceptable alternative</p><p className="mt-1">{out.strategy.acceptableAlternative ?? "—"}</p></div>
        </div>
        {out.strategy.unresolved.length ? <MissingNote items={out.strategy.unresolved} what="still unresolved with the landlord" /> : <p className="text-sm"><Status s="approved" label="Nothing open" /></p>}
        <div className="text-sm"><p className="font-semibold"><span aria-hidden>! </span>Risks</p>{out.strategy.risks.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5">{out.strategy.risks.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="text-ink-soft">None flagged</p>}</div>
        {editor && (
          <ActionForm action={talkingPointsAction}>
            <input type="hidden" name="id" value={a.id} />
            <Submit variant="secondary">Draft talking points (optional AI wording)</Submit>
          </ActionForm>
        )}
      </Panel>

      {editor && (
        <section className="space-y-4" aria-labelledby="nego-add-h">
          <H sub={`Pre-filled with ${versions[versions.length - 1].label}. Change only what the landlord changed; earlier offers stay exactly as recorded.`}><span id="nego-add-h">Record Offer {versions.length + 1}</span></H>
          <ActionForm action={addOfferAction} className="space-y-5" dataTour="nego-add-offer">
            <input type="hidden" name="id" value={a.id} />
            <BlankHint />
            <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
              <In label="Discount rate" unit="% per year" name="discount" inputMode="decimal" required defaultValue={String(latest.discountRatePct)} hint="Keep the same as earlier offers for a fair comparison." />
              <In label="Note" name="note" placeholder="Landlord counter after site visit" />
            </div>
            <LeaseTermFields p="o0_" def={latest} title={`Offer ${versions.length + 1} — financial terms`} extra={<NonFinancialFields def={latest} />} />
            <StickyBar note="Saves a new version. Nothing is sent to anyone.">
              <Submit dataTour="nego-save-offer">Save as Offer {versions.length + 1}</Submit>
            </StickyBar>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
