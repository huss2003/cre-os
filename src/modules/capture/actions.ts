"use server";
import { atLocal } from "@/lib/util/time";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError } from "@/modules/changes/http";
import type { ActionState } from "@/modules/changes/ui/client";
import { createCapture, processCapture, submitReview, type CaptureKind } from "./service";

const KINDS: CaptureKind[] = ["text", "audio", "image", "mixed"];

/** Quick capture: store once, enqueue capture.process, run it inline so the review screen is ready, open review. */
export async function captureAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let target: string | null = null;
  try {
    const ctx = await requireContext("editor");
    const kind = String(form.get("kind") ?? "text") as CaptureKind;
    const sourceLocal = String(form.get("source_at") ?? "");
    const { capture, duplicate } = await createCapture(ctx.db, ctx.workspaceId, ctx.userId, {
      kind: KINDS.includes(kind) ? kind : "text",
      text: String(form.get("text") ?? ""),
      // datetime-local has no zone: interpret as the business timezone (IST), not the server's UTC.
      sourceAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sourceLocal) ? atLocal(sourceLocal.slice(0, 10), sourceLocal.slice(11, 16)).toISOString() : null,
      languageHint: String(form.get("language_hint") ?? "") || null,
      consentReference: String(form.get("consent_reference") ?? "") || null,
      storagePath: String(form.get("storage_path") ?? "") || null,
    }, String(form.get("idem") ?? "") || null);
    if (!duplicate) {
      try { await processCapture(createAdminClient(), ctx.workspaceId, capture.id); }
      catch { /* status 'failed' is shown on the review screen; the queued job retries */ }
    }
    target = `/capture/${capture.id}`;
  } catch (e) { return { error: actionError(e) }; }
  redirect(target);
}

/** Review screen: confirm an entity, answer a question, choose the requirement, or mark reviewed. */
export async function reviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const id = String(form.get("capture_id") ?? "");
    const resolutions: Record<string, string> = {};
    const answers: Record<string, string | number | null> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v !== "string" || v === "") continue;
      if (k.startsWith("resolve:")) resolutions[k.slice(8)] = v;
      if (k.startsWith("answer:")) answers[k.slice(7)] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    const text = String(form.get("text") ?? "");
    const r = (await submitReview(ctx.db, createAdminClient(), ctx.workspaceId, ctx.userId, id, {
      resolutions, answers, text: text || null, done: form.get("done") === "1",
    })) as { applied?: number; failed?: string[] };
    refresh();
    if (form.get("done") === "1") {
      const extra = r.failed?.length ? ` ${r.failed.length} change(s) could not be applied and are waiting in Approvals.` : "";
      return { ok: true, message: `Reviewed. The meeting, tasks and ${r.applied ?? 0} record change(s) are now in their sections.${extra}` };
    }
    return { ok: true, message: "Answers saved. Press Reviewed when everything looks right." };
  } catch (e) { return { error: actionError(e) }; }
}
