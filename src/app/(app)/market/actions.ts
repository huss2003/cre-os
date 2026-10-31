"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { draftMarketNote, setMarketNoteStatus } from "@/modules/intelligence/market/service";

export async function noteAction(form: FormData) {
  await formAction("/market", "editor", async (ctx) => {
    const [metric, geography] = (str(form, "series") ?? "").split("|");
    await draftMarketNote(ctx.db, ctx.workspaceId, { metric, geography, audience: str(form, "audience") }, { userId: ctx.userId });
    return "Market note drafted from gated observations. Review the commentary label and confidentiality before sharing.";
  });
}

export async function noteStatusAction(form: FormData) {
  await formAction("/market", "editor", async (ctx) => {
    const status = str(form, "status") as "in_review" | "approved" | "published_manually" | "discarded";
    await setMarketNoteStatus(ctx.db, ctx.workspaceId, str(form, "id") ?? "", status, form.get("confidentiality") === "on" ? true : undefined);
    return `Note marked ${status.replace(/_/g, " ")}.`;
  });
}
