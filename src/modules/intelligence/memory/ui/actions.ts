"use server";
/** Done / Dismiss from an entity panel: updates only the user's recommendation state, then returns to the same page. */
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { setRecommendationState } from "../recommend/service";
import { setChangeState } from "../changes/service";

const back = (f: FormData) => { const b = str(f, "back"); return b && b.startsWith("/") && !b.startsWith("//") ? b : "/intelligence/recommendations"; };

export async function panelRecStateAction(form: FormData) {
  const to = back(form);
  await formAction(to, "editor", async (ctx) => {
    const state = str(form, "state") === "dismissed" ? "dismissed" : "done";
    await setRecommendationState({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId } as Parameters<typeof setRecommendationState>[0], str(form, "id") ?? "", state);
    return state === "done" ? "Marked done." : "Dismissed.";
  });
}

export async function panelChangeStateAction(form: FormData) {
  const to = back(form);
  await formAction(to, "editor", async (ctx) => {
    const state = str(form, "state") === "dismissed" ? "dismissed" : "acknowledged";
    await setChangeState({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId } as Parameters<typeof setChangeState>[0], str(form, "id") ?? "", state);
    return state === "dismissed" ? "Change dismissed." : "Change acknowledged.";
  });
}
