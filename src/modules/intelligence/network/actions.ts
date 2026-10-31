"use server";
import { formAction, str } from "../ui/actions";
import { recordRelationship, endRelationship, recordIntroConsent, revokeIntroConsent, draftIntroRequest } from "./relationships";
import { verifyJobMove } from "./service";

/** Return path: only same-app relative paths (people page or /network). */
const backOf = (form: FormData) => {
  const b = str(form, "back") ?? "/network";
  return /^\/(people\/[0-9a-f-]{36}|network)(\?[\w=&%-]*)?$/i.test(b) ? b : "/network";
};

export async function relationshipAction(form: FormData) {
  const back = backOf(form);
  await formAction(back, "editor", async (ctx) => {
    const r = await recordRelationship(ctx.db, ctx.workspaceId, {
      fromKind: str(form, "from") === "me" ? "me" : "person", fromPersonId: str(form, "from") === "me" ? null : str(form, "from"),
      toPersonId: str(form, "to_person_id") ?? "", edgeType: (str(form, "edge_type") ?? "other") as never, warmth: (str(form, "warmth") ?? null) as never,
      strengthBasis: str(form, "strength_basis"), lastContact: str(form, "last_contact"),
    }, ctx.userId);
    return r.created ? "Relationship recorded. Introduction permission is not assumed — record consent separately." : "Relationship updated.";
  });
}

export async function endRelationshipAction(form: FormData) {
  const back = backOf(form);
  await formAction(back, "editor", async (ctx) => {
    await endRelationship(ctx.db, ctx.workspaceId, str(form, "edge_id") ?? "", Number(str(form, "row_version")));
    return "Relationship ended (kept as history).";
  });
}

export async function consentAction(form: FormData) {
  const back = backOf(form);
  await formAction(back, "editor", async (ctx) => {
    await recordIntroConsent(ctx.db, ctx.workspaceId, {
      edgeId: str(form, "edge_id") ?? "", givenBy: (str(form, "given_by") ?? "introducer") as never, givenOn: str(form, "given_on") ?? "",
      method: (str(form, "method") ?? "conversation") as never, evidence: str(form, "evidence"), scope: str(form, "scope"), expiresOn: str(form, "expires_on"),
    }, ctx.userId);
    return "Introduction consent recorded (who, how, when — and by you).";
  });
}

export async function revokeConsentAction(form: FormData) {
  const back = backOf(form);
  await formAction(back, "editor", async (ctx) => {
    await revokeIntroConsent(ctx.db, ctx.workspaceId, str(form, "consent_id") ?? "", str(form, "reason"));
    return "Consent revoked. Introduction drafts through this person are blocked.";
  });
}

export async function introDraftAction(form: FormData) {
  const back = backOf(form);
  await formAction(back, "editor", async (ctx) => {
    const d = await draftIntroRequest(ctx.db, ctx.workspaceId, { edgeId: str(form, "edge_id") ?? "", userId: ctx.userId });
    return { notice: "Introduction request drafted — review and send it yourself from Drafts.", to: `${back.split("?")[0]}?draft=${d.id}` };
  });
}

export async function verifyMoveAction(form: FormData) {
  await formAction("/network", "editor", async (ctx) => {
    const r = await verifyJobMove(ctx.db, ctx.workspaceId, str(form, "claim_id") ?? "", str(form, "note"));
    return `Job move confirmed${r.taskClosed ? " and the verification task closed" : ""}. Approve the employment changes in Approvals to update history.`;
  });
}
