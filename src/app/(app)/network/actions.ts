"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { recordJobMove, draftReconnect } from "@/modules/intelligence/network/service";

export async function jobMoveAction(form: FormData) {
  await formAction("/network", "editor", async (ctx) => {
    const r = await recordJobMove(ctx.db, ctx.workspaceId, {
      personId: str(form, "person_id"), personName: str(form, "person_name"), fromOrgId: str(form, "from_org_id"), toOrgId: str(form, "to_org_id") ?? "",
      newTitle: str(form, "new_title"), effectiveOn: str(form, "effective_on"), sourceUrl: str(form, "source_url"), sourceNote: str(form, "source_note"),
      sourceKind: (str(form, "source_kind") ?? "other") as never,
    }, ctx.userId);
    if (r.status === "needs_identity") {
      return r.candidates?.length ? `Pick the person explicitly — possible matches: ${r.candidates.map((c) => `${c.full_name}${c.current_orgs.length ? ` (${c.current_orgs.join(", ")})` : ""}`).join("; ")}.` : "Choose the person from the list (a name alone never selects or merges a record).";
    }
    return { notice: `Job move recorded as evidence; ${r.proposals?.length ?? 0} change(s) sent to Approvals. ${(r.flags ?? []).join(" ")}` };
  });
}

export async function reconnectAction(form: FormData) {
  await formAction("/network", "editor", async (ctx) => {
    const d = await draftReconnect(ctx.db, ctx.workspaceId, { personId: str(form, "person_id") ?? "", orgId: str(form, "org_id") ?? "", channel: form.get("channel") === "linkedin" ? "linkedin" : "email", userId: ctx.userId });
    return { notice: "Reconnect draft created — review and send it yourself from Drafts.", to: `/network?draft=${d.id}` };
  });
}
