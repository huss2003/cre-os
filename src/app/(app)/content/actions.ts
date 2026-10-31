"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import {
  planWeek, addPostIdea, draftPost, checkPost, approvePost, markPublished, discardPost, saveVoiceSamples,
  confirmBrandReview, linkMarketNote, addPublicFact, removeEvidence, setPlannedDate, saveBrandRules, saveConfidentialTerms,
} from "@/modules/intelligence/content/service";

export async function planAction() {
  await formAction("/content", "editor", async (ctx) => {
    const r = await planWeek(ctx.db, ctx.workspaceId, ctx.userId);
    return r.created ? `Added ${r.created} idea(s) with planned dates for the week of ${r.week}.` : `The week of ${r.week} is already planned.`;
  });
}

export async function ideaAction(form: FormData) {
  await formAction("/content", "editor", async (ctx) => {
    await addPostIdea(ctx.db, ctx.workspaceId, { topic: str(form, "topic") ?? "", audience: (str(form, "audience") ?? "general") as never, channel: (str(form, "channel") ?? "linkedin") as never, plannedPublishOn: str(form, "planned"), marketNoteId: str(form, "note_id") }, ctx.userId);
    return "Idea added.";
  });
}

export async function postAction(form: FormData) {
  const id = str(form, "id") ?? "";
  const op = str(form, "op");
  await formAction("/content", "editor", async (ctx) => {
    switch (op) {
      case "draft": await draftPost(ctx.db, ctx.workspaceId, id); return "Draft written from approved evidence — review the fact check and checklist.";
      case "save": await checkPost(ctx.db, ctx.workspaceId, id, { body: String(form.get("body") ?? ""), status: "in_review" }); return "Saved and re-checked.";
      case "brand_ok": await confirmBrandReview(ctx.db, ctx.workspaceId, id); return "Brand review confirmed for this exact text (any edit resets it).";
      case "approve": await approvePost(ctx.db, ctx.workspaceId, id); return "Approved — marked ready. Publish it yourself, then record the link.";
      case "published": await markPublished(ctx.db, ctx.workspaceId, id, str(form, "url")); return "Recorded as published manually.";
      case "discard": await discardPost(ctx.db, ctx.workspaceId, id); return "Discarded.";
      default: throw new Error("Unknown action.");
    }
  });
}

export async function linkNoteAction(form: FormData) {
  await formAction("/content", "editor", async (ctx) => {
    await linkMarketNote(ctx.db, ctx.workspaceId, str(form, "id") ?? "", str(form, "note_id"));
    return str(form, "note_id") ? "Approved market note linked as evidence." : "Market note unlinked.";
  });
}

export async function publicFactAction(form: FormData) {
  await formAction("/content", "editor", async (ctx) => {
    await addPublicFact(ctx.db, ctx.workspaceId, str(form, "id") ?? "", { text: str(form, "text") ?? "", sourceName: str(form, "source_name") ?? "", sourceUrl: str(form, "source_url") ?? "", sourceDate: str(form, "source_date") ?? "" }, ctx.userId);
    return "Public-source fact added as evidence.";
  });
}

export async function removeEvidenceAction(form: FormData) {
  await formAction("/content", "editor", async (ctx) => {
    await removeEvidence(ctx.db, ctx.workspaceId, str(form, "id") ?? "", str(form, "ref") ?? "");
    return "Evidence removed — re-checked.";
  });
}

export async function dateAction(form: FormData) {
  await formAction(str(form, "back") === "calendar" ? "/content/calendar" : "/content", "editor", async (ctx) => {
    await setPlannedDate(ctx.db, ctx.workspaceId, str(form, "id") ?? "", str(form, "planned"));
    return str(form, "planned") ? `Planned for ${str(form, "planned")}.` : "Unscheduled.";
  });
}

export async function voiceAction(form: FormData) {
  await formAction("/content", "admin", async (ctx) => {
    const samples = String(form.get("samples") ?? "").split(/\n-{3,}\n/);
    const saved = await saveVoiceSamples(ctx.db, ctx.workspaceId, samples);
    return `${saved.length} voice sample(s) saved.`;
  });
}

export async function guardrailsAction(form: FormData) {
  await formAction("/content", "admin", async (ctx) => {
    const lines = (k: string) => String(form.get(k) ?? "").split(/\r?\n/);
    const rules = await saveBrandRules(ctx.db, ctx.workspaceId, lines("brand_rules"));
    const terms = await saveConfidentialTerms(ctx.db, ctx.workspaceId, lines("confidential_terms"));
    return `Saved ${rules.length} brand rule(s) and ${terms.length} confidential term(s). Existing drafts are re-checked when next saved.`;
  });
}
