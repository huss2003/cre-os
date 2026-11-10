"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { saveAnalysis } from "./store";
import { compareConventionalManaged, CVM_VERSION, MANAGED_SERVICES, type CvmInput, type ManagedService } from "./calc/managed";
import { compareRenewalRelocation, NONFIN, RVR_VERSION, type RvrInput } from "./calc/renewal";

/** Raw text from the form: blank stays "" (unknown), never coerced to 0 (S6). Numbers are parsed by the calculator. */
const t = (f: FormData, k: string) => String(f.get(k) ?? "").replace(/[,₹\s]/g, "");
const txt = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function cvmFromForm(f: FormData): CvmInput {
  const included = f.getAll("m_included").map(String).filter((s): s is ManagedService => (MANAGED_SERVICES as readonly string[]).includes(s));
  const basis = (k: string) => (txt(f, k) === "carpet" ? "carpet" : "chargeable") as "carpet" | "chargeable";
  return {
    comparisonMonths: t(f, "comparisonMonths"), headcount: t(f, "headcount"),
    weights: { cost: t(f, "w_cost"), flexibility: t(f, "w_flexibility"), commitment: t(f, "w_commitment"), speed: t(f, "w_speed"), control: t(f, "w_control") },
    conventional: {
      rentRate: t(f, "c_rentRate"), rentBasis: basis("c_rentBasis"), chargeableSf: t(f, "c_chargeableSf"), carpetSf: t(f, "c_carpetSf"), seats: t(f, "c_seats"),
      camRate: t(f, "c_camRate"), camBasis: basis("c_camBasis"), deposit: t(f, "c_deposit"), fitout: t(f, "c_fitout"), furniture: t(f, "c_furniture"), it: t(f, "c_it"),
      restoration: t(f, "c_restoration"), utilitiesMonthly: t(f, "c_utilitiesMonthly"), housekeepingMonthly: t(f, "c_housekeepingMonthly"),
      maintenanceMonthly: t(f, "c_maintenanceMonthly"), parkingMonthly: t(f, "c_parkingMonthly"), otherServicesMonthly: t(f, "c_otherServicesMonthly"),
      tenureMonths: t(f, "c_tenureMonths"), lockInMonths: t(f, "c_lockInMonths"), escalation: { pct: t(f, "c_escPct"), everyMonths: t(f, "c_escEvery") },
      monthsToOccupy: t(f, "c_monthsToOccupy"), control: t(f, "c_control"), notes: txt(f, "c_notes"),
    },
    managed: {
      perSeatPrice: t(f, "m_perSeatPrice"), seats: t(f, "m_seats"), contractMonths: t(f, "m_contractMonths"), lockInMonths: t(f, "m_lockInMonths"), included,
      meetingRoomHours: t(f, "m_meetingRoomHours"), internetMonthly: t(f, "m_internetMonthly"), utilitiesMonthly: t(f, "m_utilitiesMonthly"),
      housekeepingMonthly: t(f, "m_housekeepingMonthly"), receptionMonthly: t(f, "m_receptionMonthly"), securityMonthly: t(f, "m_securityMonthly"),
      maintenanceMonthly: t(f, "m_maintenanceMonthly"), parkingMonthly: t(f, "m_parkingMonthly"), furniture: t(f, "m_furniture"), it: t(f, "m_it"),
      deposit: t(f, "m_deposit"), setup: t(f, "m_setup"), addOnsMonthly: t(f, "m_addOnsMonthly"), exclusions: txt(f, "m_exclusions"),
      escalation: { pct: t(f, "m_escPct"), everyMonths: t(f, "m_escEvery") }, flexibilityNotes: txt(f, "m_flexibilityNotes"),
      monthsToOccupy: t(f, "m_monthsToOccupy"), control: t(f, "m_control"),
    },
  };
}

function rvrFromForm(f: FormData): RvrInput {
  return {
    comparisonMonths: t(f, "comparisonMonths"), discountRatePct: t(f, "discountRatePct"),
    scores: Object.fromEntries(NONFIN.map((k) => [k, { renewal: t(f, `s_${k}_r`), relocation: t(f, `s_${k}_l`) }])),
    renewal: {
      currentRentMonthly: t(f, "r_currentRentMonthly"), proposedRentMonthly: t(f, "r_proposedRentMonthly"), escalation: { pct: t(f, "r_escPct"), everyMonths: t(f, "r_escEvery") },
      extensionMonths: t(f, "r_extensionMonths"), rentFreeMonths: t(f, "r_rentFreeMonths"), camMonthly: t(f, "r_camMonthly"), depositChange: t(f, "r_depositChange"),
      refurbishment: t(f, "r_refurbishment"), maintenanceMonthly: t(f, "r_maintenanceMonthly"), otherMonthly: t(f, "r_otherMonthly"), otherOneOff: t(f, "r_otherOneOff"),
    },
    relocation: {
      newRentMonthly: t(f, "l_newRentMonthly"), escalation: { pct: t(f, "l_escPct"), everyMonths: t(f, "l_escEvery") }, rentFreeMonths: t(f, "l_rentFreeMonths"),
      camMonthly: t(f, "l_camMonthly"), deposit: t(f, "l_deposit"), oldDepositReturned: t(f, "l_oldDepositReturned"), fitout: t(f, "l_fitout"), moving: t(f, "l_moving"),
      restorationOld: t(f, "l_restorationOld"), overlapMonths: t(f, "l_overlapMonths"), brokerage: t(f, "l_brokerage"), itRelocation: t(f, "l_itRelocation"),
      downtimeCost: t(f, "l_downtimeCost"), employeeTransition: t(f, "l_employeeTransition"), otherMonthly: t(f, "l_otherMonthly"), otherOneOff: t(f, "l_otherOneOff"),
    },
  };
}

export async function saveManagedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const inputs = cvmFromForm(form);
    const outputs = compareConventionalManaged(inputs);
    const res = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
      id: txt(form, "id") || null, kind: "conventional_vs_managed", title: txt(form, "title") || "Conventional vs managed",
      inputs, outputs, formulaVersion: CVM_VERSION, missing: outputs.missing, note: txt(form, "note") || null,
    });
    id = res.id;
  } catch (e) { return { error: errorMessage(e) }; }
  revalidatePath("/toolkit/managed");
  redirect(`/toolkit/managed/${id}`);
}

export async function saveRenewalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const inputs = rvrFromForm(form);
    const outputs = compareRenewalRelocation(inputs);
    const res = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
      id: txt(form, "id") || null, kind: "renewal_vs_relocation", title: txt(form, "title") || "Renewal vs relocation",
      inputs, outputs, formulaVersion: RVR_VERSION, missing: outputs.missing, note: txt(form, "note") || null,
    });
    id = res.id;
  } catch (e) { return { error: errorMessage(e) }; }
  revalidatePath("/toolkit/renewal");
  redirect(`/toolkit/renewal/${id}`);
}
