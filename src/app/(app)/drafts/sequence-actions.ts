"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { SuppressedRecipientError } from "@/lib/services/drafts";
import { ActiveNegotiationError, activateEnrollment, cancelEnrollment, CollisionError, pauseEnrollment, proposeEnrollment } from "@/modules/integrations/sequences";

/**
 * Outreach sequence enrolment (workflow 13). One person per enrolment (no bulk). Enrolling creates the first step as a
 * DRAFT only; activating lets the hourly tick draft later steps; the user approves and sends every step by hand.
 */
const back = (notice: string, extra = "") => redirect(`/drafts?tab=sequences&notice=${notice}${extra}`);

const enrolSchema = z.object({
  personId: z.string().uuid(),
  template: z.string().max(40).optional(),
  sequenceId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  persona: z.string().max(40).optional(),
  valueProposition: z.string().trim().min(5).max(200),
  override: z.literal("yes").optional(),
});

export async function enrolAction(form: FormData) {
  const ctx = await requireContext("editor");
  const raw = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string>;
  const seq = raw.sequence ?? "";
  const parsed = enrolSchema.safeParse({ ...raw, template: seq.startsWith("tpl:") ? seq.slice(4) : undefined, sequenceId: seq.startsWith("seq:") ? seq.slice(4) : undefined });
  if (!parsed.success) back("enrol_invalid", raw.personId ? `&person=${encodeURIComponent(raw.personId)}` : "");
  const p = parsed.data!;
  let notice = "enrolled";
  try {
    const r = await proposeEnrollment(ctx.db, ctx.workspaceId, {
      personId: p.personId, template: p.template, sequenceId: p.sequenceId, opportunityId: p.opportunityId ?? null, persona: p.persona ?? null,
      valueProposition: p.valueProposition, userId: ctx.userId, overrideCollision: p.override === "yes",
    });
    if (r.existing) notice = "enrol_existing";
  } catch (e) {
    if (e instanceof CollisionError) notice = "enrol_collision";
    else if (e instanceof SuppressedRecipientError) notice = "enrol_suppressed";
    else throw e;
    revalidatePath("/drafts");
    back(notice, `&person=${p.personId}`);
  }
  revalidatePath("/drafts");
  back(notice);
}

export async function enrollmentAction(form: FormData) {
  const ctx = await requireContext("editor");
  const id = z.string().uuid().parse(form.get("id"));
  const action = z.enum(["activate", "pause", "resume", "cancel"]).parse(form.get("action"));
  let notice = `enr_${action}`;
  try {
    if (action === "activate" || action === "resume") await activateEnrollment(ctx.db, ctx.workspaceId, id);
    else if (action === "pause") await pauseEnrollment(ctx.db, ctx.workspaceId, id, "manual", ctx.userId, "Paused by hand");
    else await cancelEnrollment(ctx.db, ctx.workspaceId, id, "manual", ctx.userId);
  } catch (e) {
    if (!(e instanceof ActiveNegotiationError)) throw e;
    notice = "enr_negotiation";
  }
  revalidatePath("/drafts");
  back(notice);
}
