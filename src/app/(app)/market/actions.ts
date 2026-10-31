"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { draftMarketNote, setMarketNoteStatus, proposeGeographyMapping, runMarketAnalysis } from "@/modules/intelligence/market/service";

export async function noteAction(form: FormData) {
  await formAction("/market", "editor", async (ctx) => {
    const key = str(form, "series") ?? "";
    const [metric, geography] = key.split("|");
    await draftMarketNote(ctx.db, ctx.workspaceId, { metric, geography, seriesKey: key, audience: str(form, "audience") }, { userId: ctx.userId });
    return "Market note drafted from gated observations, with sources, sample size and caveats. Review the commentary label and confidentiality before sharing.";
  });
}

export async function noteStatusAction(form: FormData) {
  await formAction("/market", "editor", async (ctx) => {
    const status = str(form, "status") as "in_review" | "approved" | "published_manually" | "discarded";
    await setMarketNoteStatus(ctx.db, ctx.workspaceId, str(form, "id") ?? "", status, form.get("confidentiality") === "on" ? true : undefined, { userId: ctx.userId });
    return status === "approved" ? "Note approved — it can now feed content drafts (a linked idea was added on the Content page)." : `Note marked ${status.replace(/_/g, " ")}.`;
  });
}

export async function geoMappingAction(form: FormData) {
  await formAction("/market", "editor", async (ctx) => {
    const r = await proposeGeographyMapping(ctx.db, ctx.workspaceId, { raw: str(form, "raw") ?? "", geographyId: str(form, "geography_id") ?? "" }, ctx.userId);
    return r.status === "already_mapped" ? "That name is already an approved alias." : "Mapping proposed — approve it on the Approvals page; the series merge only after approval.";
  });
}

export async function analysisAction() {
  await formAction("/market", "editor", async (ctx) => {
    const r = await runMarketAnalysis(ctx.db, ctx.workspaceId, { trigger: "manual", ownerUserId: ctx.userId });
    const flags = Array.isArray(r.analysis.flags) ? r.analysis.flags.length : 0;
    return `Analysis refreshed: ${String(r.analysis.series_count)} series, ${flags} flag(s).`;
  });
}
