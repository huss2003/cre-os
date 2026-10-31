"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { planWeek, addPostIdea, draftPost, checkPost, approvePost, markPublished, discardPost, saveVoiceSamples } from "@/modules/intelligence/content/service";

export async function planAction() {
  await formAction("/content", "editor", async (ctx) => {
    const r = await planWeek(ctx.db, ctx.workspaceId, ctx.userId);
    return r.created ? `Added ${r.created} idea(s) for the week of ${r.week}.` : `The week of ${r.week} is already planned.`;
  });
}

export async function ideaAction(form: FormData) {
  await formAction("/content", "editor", async (ctx) => {
    await addPostIdea(ctx.db, ctx.workspaceId, { topic: str(form, "topic") ?? "", audience: (str(form, "audience") ?? "general") as never, channel: (str(form, "channel") ?? "linkedin") as never }, ctx.userId);
    return "Idea added.";
  });
}

export async function postAction(form: FormData) {
  const id = str(form, "id") ?? "";
  const op = str(form, "op");
  await formAction("/content", "editor", async (ctx) => {
    switch (op) {
      case "draft": await draftPost(ctx.db, ctx.workspaceId, id); return "Draft written in your voice — review the checklist.";
      case "save": await checkPost(ctx.db, ctx.workspaceId, id, { body: String(form.get("body") ?? ""), status: "in_review" }); return "Saved and re-checked.";
      case "approve": await approvePost(ctx.db, ctx.workspaceId, id); return "Approved. Publish it yourself, then record the link.";
      case "published": await markPublished(ctx.db, ctx.workspaceId, id, str(form, "url")); return "Recorded as published manually.";
      case "discard": await discardPost(ctx.db, ctx.workspaceId, id); return "Discarded.";
      default: throw new Error("Unknown action.");
    }
  });
}

export async function voiceAction(form: FormData) {
  await formAction("/content", "admin", async (ctx) => {
    const samples = String(form.get("samples") ?? "").split(/\n-{3,}\n/);
    const saved = await saveVoiceSamples(ctx.db, ctx.workspaceId, samples);
    return `${saved.length} voice sample(s) saved.`;
  });
}
