"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { setMonthlyBudget, UsageError } from "./service";

export async function setBudgetAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const raw = String(f.get("budget") ?? "").replace(/[,₹\s]/g, "");
    if (raw === "" || Number.isNaN(Number(raw))) return { error: "Enter the monthly budget in rupees (0 = no cap)." };
    const ctx = await requireContext("viewer");
    const r = await setMonthlyBudget(ctx, Number(raw));
    revalidatePath("/assistant/usage");
    return { ok: true, message: r.budgetInr > 0 ? `Budget set to ₹${r.budgetInr.toLocaleString("en-IN")} a month.` : "Budget cap removed." };
  } catch (e) { return { error: e instanceof UsageError ? e.message : errorMessage(e) }; }
}
