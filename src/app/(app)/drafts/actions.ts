"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { importEml } from "@/modules/integrations/inbox";

/** Manual selected-thread import (.eml pasted or uploaded) — the default Gmail path; RLS via the user client. */
export async function importEmlAction(form: FormData) {
  const ctx = await requireContext("editor");
  const file = form.get("file");
  let raw = String(form.get("raw") ?? "");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > 2_000_000) redirect("/drafts?tab=inbox&notice=too_large");
    raw = await file.text();
  }
  if (!raw.trim()) redirect("/drafts?tab=inbox&notice=empty");
  let notice = "imported";
  try {
    const r = await importEml(ctx.db, ctx.workspaceId, raw, ctx.userId);
    notice = r.inserted ? (r.effects.draftId ? "imported_draft" : "imported") : "duplicate";
  } catch (e) {
    console.error("eml import failed", e);
    notice = "import_failed";
  }
  revalidatePath("/drafts");
  redirect(`/drafts?tab=inbox&notice=${notice}`);
}
