"use server";
import { formAction, str, intOrNull } from "@/modules/intelligence/ui/actions";
import { addPlaybookItem, createExperiment } from "@/modules/intelligence/insights/service";
import { saveStrategySnapshot, addNegotiationNote, setConcessionStatus } from "@/modules/intelligence/strategy/service";

export async function playbookAction(form: FormData) {
  await formAction("/insights", "editor", async (ctx) => {
    await addPlaybookItem(ctx.db, ctx.workspaceId, {
      kind: (str(form, "kind") ?? "question") as never, prompt: str(form, "prompt") ?? "", response: str(form, "response"), persona: str(form, "persona"), stage: str(form, "stage"),
      tags: (str(form, "tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean), sourceRights: (str(form, "source_rights") ?? "own_experience") as never,
      anonymised: (form.get("anonymised") === "on") as true,
    }, ctx.userId);
    return "Added to the playbook.";
  });
}

export async function experimentAction(form: FormData) {
  await formAction("/insights", "editor", async (ctx) => {
    const variants = (str(form, "variants") ?? "").split(",").map((v) => v.trim()).filter(Boolean).map((l, i) => ({ key: `v${i + 1}`, label: l }));
    await createExperiment(ctx.db, ctx.workspaceId, {
      name: str(form, "name") ?? "", hypothesis: str(form, "hypothesis") ?? "", dimension: (str(form, "dimension") ?? "trigger") as never, variants,
      outcomeWindowDays: intOrNull(form, "window") ?? 60, minSamplePerVariant: intOrNull(form, "min_sample") ?? 30,
    }, ctx.userId);
    return "Experiment designed. Results show only once every subject's outcome window has elapsed.";
  });
}

export async function strategyAction(form: FormData) {
  const id = str(form, "opportunity_id") ?? "";
  const path = `/insights/deals/${id}`;
  const op = str(form, "op");
  await formAction(path, "editor", async (ctx) => {
    if (op === "note") { await addNegotiationNote(ctx.db, ctx.workspaceId, id, str(form, "note") ?? "", ctx.userId); return "Note saved."; }
    if (op === "concession") { await setConcessionStatus(ctx.db, ctx.workspaceId, str(form, "item_id") ?? "", (str(form, "status") ?? "proposed") as never, intOrNull(form, "row_version") ?? undefined); return "Concession updated."; }
    const r = await saveStrategySnapshot(ctx.db, ctx.workspaceId, id, ctx.userId);
    return r.saved ? "Snapshot saved to the negotiation log." : "Today's snapshot already exists.";
  });
}
