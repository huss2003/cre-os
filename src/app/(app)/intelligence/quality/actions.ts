"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { correctMemoryStatus, detectChanges, memCtxFromTool, setChangeState, setRecommendationState } from "@/modules/intelligence/memory/integrate";
import type { MemoryStatus } from "@/modules/intelligence/memory/types";

const PATH = "/intelligence/quality";

export async function scanAction() {
  await formAction(PATH, "editor", async (ctx) => {
    const r = await detectChanges(memCtxFromTool(ctx), { all: true });
    return `Scan finished: ${r.detected.length} change(s) on record, ${r.inserted.length} new, ${r.recommendations} new recommendation(s). Nothing was sent or changed in your records.`;
  });
}

export async function changeStateAction(form: FormData) {
  await formAction(PATH, "editor", async (ctx) => {
    await setChangeState(memCtxFromTool(ctx), str(form, "id") ?? "", (str(form, "state") ?? "acknowledged") as "acknowledged" | "dismissed");
    return "Change updated.";
  });
}

export async function recStateAction(form: FormData) {
  await formAction(PATH, "editor", async (ctx) => {
    await setRecommendationState(memCtxFromTool(ctx), str(form, "id") ?? "", (str(form, "state") ?? "done") as "done" | "dismissed");
    return "Recommendation updated.";
  });
}

export async function correctAction(form: FormData) {
  await formAction(PATH, "editor", async (ctx) => {
    await correctMemoryStatus(memCtxFromTool(ctx), {
      entityType: str(form, "entity_type") ?? "", entityId: str(form, "entity_id") ?? "", category: str(form, "category") ?? "general",
      itemKey: str(form, "item_key") ?? "", status: (str(form, "status") ?? "unverified") as MemoryStatus, note: str(form, "note") ?? "",
    });
    return "Correction saved — the previous status stays in the history.";
  });
}
