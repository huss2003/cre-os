"use server";
/** Module 14 server actions (signed-in user, RLS). Redirect back with ?msg= / ?err=. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { toDealsCtx } from "../api";
import { DealsError } from "../ctx";
import { assertReadyToPresent, recordShortlistFeedback, upsertOperatorCentre } from "./service";

const s = (f: FormData, k: string) => { const v = f.get(k); return v === null ? "" : String(v).trim(); };
const n = (f: FormData, k: string) => { const v = s(f, k); if (!v) return null; const x = Number(v.replace(/,/g, "")); return Number.isFinite(x) ? x : null; };
const list = (f: FormData, k: string) => s(f, k).split(",").map((x) => x.trim()).filter(Boolean);
const err = (e: unknown) => e instanceof DealsError ? [e.message, ...(Array.isArray(e.details) ? (e.details as { label: string; items: { text: string }[] }[]).map((d) => `${d.label}: ${d.items.map((i) => i.text).join(", ")}`) : [])].join(" · ").slice(0, 600) : String((e as Error)?.message ?? e).slice(0, 400);
const back = (path: string, k: "msg" | "err", v: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`);

export async function addOperatorCentreAction(f: FormData) {
  const path = "/buildings/supply?tab=operators";
  try {
    const ctx = toDealsCtx(await requireContext());
    await upsertOperatorCentre(ctx, {
      operator_name: s(f, "operator_name"), centre_name: s(f, "centre_name"), category: s(f, "category") === "coworking" ? "coworking" : "managed_office",
      capacity_seats: n(f, "capacity_seats"), seats_available: n(f, "seats_available"), private_offices: n(f, "private_offices"),
      price_per_seat_min: n(f, "price_per_seat_min"), price_per_seat_max: n(f, "price_per_seat_max"), services: list(f, "services"), amenities: list(f, "amenities"),
      brokerage_conditions: s(f, "brokerage_conditions") || null, source_label: s(f, "source_label") || null, last_verified_on: s(f, "last_verified_on") || null,
    });
  } catch (e) { back(path, "err", err(e)); }
  revalidatePath("/buildings/supply");
  back(path, "msg", "Centre saved");
}

export async function shortlistFeedbackAction(f: FormData) {
  const path = `/buildings/supply?tab=match&requirement=${encodeURIComponent(s(f, "requirement_id"))}`;
  try {
    const ctx = toDealsCtx(await requireContext());
    await recordShortlistFeedback(ctx, { optionId: s(f, "option_id"), kind: s(f, "kind") === "rejection" ? "rejection" : "client_feedback", reasonCode: s(f, "reason_code") || null, comment: s(f, "comment") || null });
  } catch (e) { back(path, "err", err(e)); }
  revalidatePath("/buildings/supply");
  back(path, "msg", "Feedback recorded");
}

export async function checkReadyAction(f: FormData) {
  const path = `/buildings/supply?tab=match&requirement=${encodeURIComponent(s(f, "requirement_id"))}`;
  try {
    const ctx = toDealsCtx(await requireContext());
    await assertReadyToPresent(ctx, s(f, "requirement_id"), { purpose: s(f, "purpose") === "site_visit" ? "site_visit" : "presentation" });
  } catch (e) { back(path, "err", err(e)); }
  back(path, "msg", "All shortlisted properties are reconfirmed — ready to present");
}
