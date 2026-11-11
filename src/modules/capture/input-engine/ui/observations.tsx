import { Badge } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { observationAction } from "../actions";
import { FACT_CLASS_LABEL, FACT_TONE, FIELD_LABEL, sourceLabel } from "./labels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const show = (v: unknown) => (v == null ? "unknown" : typeof v === "object" ? Object.values(v as Row).filter((x) => x != null).join(" ") || "unknown" : String(v));
const REVIEW: Record<string, string> = {
  uncertain_company_match: "Which company?", uncertain_contact_match: "Which contact?", potential_duplicate: "Repeat of an earlier source",
  conflicting_commercial_value: "Differs from the saved value", missing_units_or_dates: "Unit / basis / date missing", unverified_lease_details: "Lease detail not verified",
  material_change_approval: "Needs approval",
};

/**
 * Extracted items (§13B): original wording, value, fact class, confidence, missing parts, conflicts, source reference, and the
 * actions confirm / edit / reject / associate / create / request clarification. Mobile-first: one card per item.
 */
export function ObservationList({ items, editor, linkOptions }: { items: Row[]; editor: boolean; linkOptions?: { value: string; label: string }[] }) {
  if (!items.length) return <p className="text-sm text-ink-soft">Nothing structured was found. The original is saved.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((o) => (
        <li key={o.id} className="space-y-2 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-ink">{FIELD_LABEL[o.field] ?? o.field}</span>
            <Badge tone={FACT_TONE[o.fact_class] ?? "neutral"}>{FACT_CLASS_LABEL[o.fact_class] ?? o.fact_class}</Badge>
            {o.status === "rejected" ? <Badge tone="bad">Rejected</Badge> : o.status === "corrected" ? <Badge tone="ok">Corrected</Badge> : o.status === "confirmed" ? <Badge tone="ok">Confirmed</Badge> : o.status === "auto_saved" ? <Badge>Saved</Badge> : <Badge tone="warn">For review</Badge>}
            {o.review_category ? <Badge tone="warn">{REVIEW[o.review_category] ?? o.review_category}</Badge> : null}
            {o.date_class ? <Badge title="confirmed = contractual date; estimated = approximate; informal = target only">{o.date_class} date</Badge> : null}
            {o.independent === false ? <Badge title="Same underlying source — not counted as new evidence">repeat</Badge> : null}
            {o.match_confidence && o.match_confidence !== "high" ? <Badge title="Confidence of the contact/company match">{o.match_confidence} match</Badge> : null}
          </div>
          <p className="text-sm">
            <span className="text-ink-soft">“{o.raw_text}”</span> → <strong>{show(o.value_json)}</strong>{o.unit ? ` ${o.unit}` : ""}
            {o.area_basis && o.area_basis !== "unknown" ? ` (${o.area_basis.replace(/_/g, " ")})` : ""}
            {o.cam_treatment ? ` · CAM ${o.cam_treatment === "unknown" ? "not stated" : o.cam_treatment}` : ""}
          </p>
          {o.source_ref?.uncertain ? <p className="text-xs text-warn">Uncertain reading{o.source_ref.uncertain_reason ? `: ${o.source_ref.uncertain_reason}` : ""} — check it against the card.</p> : null}
          {o.missing?.length ? <p className="text-xs text-warn">Unknown: {o.missing.join(", ").replace(/_/g, " ")} — left unknown, not assumed.</p> : null}
          {o.conflict_with ? <p className="text-xs text-warn">Differs from an earlier value — the earlier value is kept (version {o.version}).</p> : null}
          <p className="text-xs text-ink-soft">Source: {sourceLabel(o.source_ref) || o.source_type} · {o.source_type.replace(/_/g, " ")} · observed {String(o.observed_at).slice(0, 10)} · {o.verification.replace(/_/g, " ")}{o.confidence != null ? ` · confidence ${Math.round(Number(o.confidence) * 100)}%` : ""}</p>
          {editor && o.status !== "rejected" ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-brand">Confirm, edit, reject…</summary>
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <ActionForm action={observationAction}><input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="confirm" /><Submit variant="secondary">Confirm</Submit></ActionForm>
                  <ActionForm action={observationAction}><input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="reject" /><Submit variant="secondary" confirm="Reject this item? Nothing on the record changes.">Reject</Submit></ActionForm>
                </div>
                <ActionForm action={observationAction} className="grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="correct" />
                  <input name="value" placeholder="Correct value" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" />
                  <select name="area_basis" defaultValue="" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"><option value="">Area basis…</option><option value="carpet">Carpet</option><option value="chargeable">Chargeable</option><option value="super_built_up">Super built-up</option></select>
                  <select name="cam_treatment" defaultValue="" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"><option value="">CAM…</option><option value="extra">CAM extra</option><option value="included">CAM included</option><option value="unknown">Not stated</option></select>
                  <select name="pricing_basis" defaultValue="" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"><option value="">Pricing basis…</option><option value="per_sf_month">per sq ft / month</option><option value="per_seat_month">per seat / month</option><option value="total_month">total / month</option></select>
                  <input name="unit" placeholder="Unit (e.g. INR/sf/month)" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" />
                  <Submit variant="secondary">Save correction</Submit>
                </ActionForm>
                {linkOptions?.length ? (
                  <ActionForm action={observationAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="associate" />
                    <select name="target" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">{linkOptions.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select>
                    <Submit variant="secondary">Link to record</Submit>
                  </ActionForm>
                ) : null}
                <ActionForm action={observationAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="create" />
                  <select name="kind" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"><option value="organisation">New company</option><option value="person">New contact</option></select>
                  <input name="name" placeholder="Name" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" />
                  <Submit variant="secondary">Create (for approval)</Submit>
                </ActionForm>
                <ActionForm action={observationAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="observation_id" value={o.id} /><input type="hidden" name="op" value="clarify" />
                  <input name="question" placeholder="Question to ask the client" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" />
                  <Submit variant="secondary">Request clarification</Submit>
                </ActionForm>
              </div>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
