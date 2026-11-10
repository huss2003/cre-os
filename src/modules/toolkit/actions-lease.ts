"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import type { ActionState } from "@/modules/admin/ui/client";
import type { LeaseTerms, Periodicity } from "./calc/lease";
import type { ConcessionPackage, OfferTerms, PackageItem } from "./calc/negotiation";
import { addOffer, createNegotiation, draftTalkingPoints, runLeaseEconomics, runOccupancy, setPackages } from "./lease-service";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
/** Blank stays unknown (null) — never coerced to 0. Commas allowed. */
const n = (f: FormData, k: string): string | null => { const v = s(f, k).replace(/,/g, ""); if (v === "") return null; if (!Number.isFinite(Number(v))) throw new Error(`"${k}" must be a number`); return v; };
const i = (f: FormData, k: string): number | null => { const v = n(f, k); return v === null ? null : Math.round(Number(v)); };
const fail = (e: unknown): ActionState => ({ error: e instanceof Error ? e.message.slice(0, 500) : "Something went wrong" });

async function who() { const c = await requireContext("editor"); return { db: c.db, ws: c.workspaceId, userId: c.userId }; }

/** Parse one offer's fields (prefix p, e.g. "o0_"). Returns null when the offer block is empty. */
function termsFrom(f: FormData, p: string, shared: { discount: string | null }): LeaseTerms | null {
  if (!s(f, `${p}area`) && !s(f, `${p}rent`)) return null;
  const otherAmt = n(f, `${p}other_amount`);
  const nrAmt = n(f, `${p}nr_amount`);
  const gstT = s(f, `${p}gst`);
  const basis = s(f, `${p}basis`) === "carpet" ? "carpet" : "chargeable";
  return {
    name: s(f, `${p}name`) || "Offer", label: s(f, `${p}label`) === "estimated" ? "estimated" : "quoted",
    areaSf: n(f, `${p}area`) ?? "", areaBasis: basis, rentPerSf: n(f, `${p}rent`) ?? "",
    leaseCommencement: s(f, `${p}lc`), rentCommencement: s(f, `${p}rc`) || null, tenureMonths: i(f, `${p}tenure`) ?? 0,
    rentFreeMonths: i(f, `${p}rf`), escalationPct: n(f, `${p}esc`), escalationEveryMonths: i(f, `${p}escevery`),
    camPerSf: n(f, `${p}cam`), parkingSlots: i(f, `${p}pslots`), parkingRatePerSlot: n(f, `${p}prate`), depositMonths: n(f, `${p}dep`),
    otherRecurring: otherAmt ? [{ label: s(f, `${p}other_label`) || "Other", amount: otherAmt, periodicity: (s(f, `${p}other_per`) === "annual" ? "annual" : "monthly") as Periodicity }] : [],
    otherRecurringState: otherAmt ? "known" : f.get(`${p}other_none`) ? "none" : "unknown",
    nonRecurring: nrAmt ? [{ label: s(f, `${p}nr_label`) || "One-off", amount: nrAmt, leaseMonth: 0 }] : [],
    gst: gstT === "included" || gstT === "excluded" || gstT === "recoverable" ? { treatment: gstT, ratePct: n(f, `${p}gst_rate`) } : null,
    discountRatePct: shared.discount ?? "",
  };
}

function offerFrom(f: FormData): OfferTerms {
  const t = termsFrom(f, "o0_", { discount: n(f, "discount") });
  if (!t) throw new Error("Enter at least the area and base rent.");
  return {
    ...t, fitoutContribution: n(f, "o0_fitout"), lockInMonths: i(f, "o0_lockin"), noticeMonths: i(f, "o0_notice"),
    breakClause: s(f, "o0_break") || null, possessionDate: s(f, "o0_possession") || null, handover: s(f, "o0_handover") || null,
    restoration: s(f, "o0_restoration") || null, other: s(f, "o0_otherterms") || null,
  };
}

export async function leaseEconomicsAction(_: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const shared = { discount: n(f, "discount") };
    const offers = [0, 1, 2, 3].map((k) => termsFrom(f, `o${k}_`, shared)).filter((x): x is LeaseTerms => !!x);
    const r = await runLeaseEconomics(await who(), { id: s(f, "id") || null, title: s(f, "title") || "Lease economics", requirementId: s(f, "requirement_id") || null, offers });
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/toolkit");
  redirect(`/toolkit/lease?id=${id}`);
}

export async function occupancyAction(_: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const terms = termsFrom(f, "o0_", { discount: n(f, "discount") });
    if (!terms) throw new Error("Enter at least the area and base rent.");
    const r = await runOccupancy(await who(), {
      id: s(f, "id") || null, title: s(f, "title") || "Occupancy economics", requirementId: s(f, "requirement_id") || null, terms,
      extras: { advanceRentMonths: n(f, "adv"), fitoutCost: n(f, "fitout"), movingCost: n(f, "moving"), initialCharges: n(f, "initial") },
      overrides: {
        rentPerSf: n(f, "s_rent"), escalationPct: n(f, "s_esc"), tenureMonths: i(f, "s_tenure"), rentFreeMonths: i(f, "s_rf"),
        camPerSf: n(f, "s_cam"), discountRatePct: n(f, "s_disc"), depositMonths: n(f, "s_dep"), otherMonthly: n(f, "s_other"),
      },
    });
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/toolkit");
  redirect(`/toolkit/occupancy?id=${id}`);
}

export async function createNegotiationAction(_: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const r = await createNegotiation(await who(), { title: s(f, "title") || "Negotiation", requirementId: s(f, "requirement_id") || null, terms: offerFrom(f) });
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/toolkit");
  redirect(`/toolkit/negotiation/${id}`);
}

export async function addOfferAction(_: ActionState, f: FormData): Promise<ActionState> {
  const id = s(f, "id");
  try { await addOffer(await who(), id, offerFrom(f), s(f, "note") || null); } catch (e) { return fail(e); }
  revalidatePath(`/toolkit/negotiation/${id}`);
  redirect(`/toolkit/negotiation/${id}`);
}

export async function packagesAction(_: ActionState, f: FormData): Promise<ActionState> {
  const id = s(f, "id");
  try {
    const pk: ConcessionPackage[] = [];
    for (let k = 0; k < 3; k++) {
      const p = `p${k}_`;
      const items: PackageItem[] = [];
      const v = (key: string) => n(f, p + key);
      if (v("rent")) items.push({ type: "lower_rent", perSf: v("rent")! });
      if (v("rf")) items.push({ type: "longer_rent_free", months: Number(v("rf")) });
      if (v("dep")) items.push({ type: "lower_deposit", months: v("dep")! });
      if (v("esc")) items.push({ type: "reduced_escalation", pctPoints: v("esc")! });
      if (v("fitout")) items.push({ type: "fitout_contribution", amount: v("fitout")! });
      if (v("parking")) items.push({ type: "extra_parking", slots: Number(v("parking")) });
      if (v("poss")) items.push({ type: "earlier_possession", months: Number(v("poss")), parallelRentMonthly: v("parallel") });
      if (v("lockin")) items.push({ type: "flexible_lock_in", months: Number(v("lockin")) });
      if (items.length) pk.push({ name: s(f, p + "name") || `Package ${k + 1}`, items });
    }
    await setPackages(await who(), id, pk);
  } catch (e) { return fail(e); }
  revalidatePath(`/toolkit/negotiation/${id}`);
  redirect(`/toolkit/negotiation/${id}`);
}

export async function talkingPointsAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const r = await draftTalkingPoints(await who(), s(f, "id"));
    return { message: `${r.mocked ? "(offline draft) " : ""}${r.points.join(" • ")}` };
  } catch (e) { return fail(e); }
}
