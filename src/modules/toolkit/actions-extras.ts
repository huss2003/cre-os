"use server";
/** Module 8 server actions: quotation intake, evidence attachments, client packs. */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import { createIntake, quoteFileText, saveIntakeVersion, termsFromForm, MAX_QUOTE_BYTES, QUOTE_BUCKET, type PartyKind } from "./quote-intake";
import { addEvidence, setVerification, EVIDENCE_KINDS, type EvidenceKind, type Verification } from "./evidence";
import { generatePacks } from "./packs";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof DealsError || e instanceof Error ? e.message : errorMessage(e) });

export async function startQuoteIntakeAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    const storagePath = s(f, "storage_path") || null;
    const fileName = s(f, "file_name") || null;
    let text = s(f, "text");
    const notes: string[] = [];
    if (storagePath) {
      if (!storagePath.startsWith(`${ctx.workspaceId}/quotes/`)) throw new Error("Invalid upload.");
      const dl = await ctx.db.storage.from(QUOTE_BUCKET).download(storagePath);
      if (dl.error || !dl.data) throw new Error(`Could not read the uploaded file: ${dl.error?.message ?? "missing"}`);
      if (dl.data.size > MAX_QUOTE_BYTES) throw new Error("File is larger than 20 MB.");
      const ex = await quoteFileText(fileName ?? storagePath, new Uint8Array(await dl.data.arrayBuffer()));
      notes.push(...ex.notes);
      if (ex.text) text = text ? `${ex.text}\n\n${text}` : ex.text;
    }
    if (!text && !storagePath) throw new Error("Upload the quote file or paste its text.");
    const party = (s(f, "party_kind") || "landlord") as PartyKind;
    const r = await createIntake(ctx, { requirementId: s(f, "requirement_id") || null, quoteId: s(f, "quote_id") || null, spaceId: s(f, "space_id") || null, partyKind: party, storagePath, fileName, text, notes });
    id = r.id;
  } catch (e) { return fail(e); }
  redirect(`/toolkit/quotes/${id}`);
}

export async function saveQuoteIntakeAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    const id = s(f, "intake_id");
    const terms = termsFromForm((k) => s(f, k));
    const r = await saveIntakeVersion(ctx, id, terms);
    revalidatePath("/toolkit/quotes"); revalidatePath(`/toolkit/quotes/${id}`);
    if (r.mode === "proposed") return { ok: true, message: "The latest version is approved, so the new version was sent for review. It appears as a quote once approved in Approvals." };
    return { ok: true, message: r.mode === "revised" ? `Saved as quote version ${r.quote.version}. Earlier versions are kept.` : "Saved as a new quote (version 1)." };
  } catch (e) { return fail(e); }
}

export async function discardQuoteIntakeAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    const r = await ctx.db.from("quote_intake").update({ status: "discarded" }).eq("workspace_id", ctx.workspaceId).eq("id", s(f, "intake_id")).eq("status", "review").select("id");
    if (r.error || !r.data?.length) throw new Error("Could not discard (already saved?).");
    revalidatePath("/toolkit/quotes");
    return { ok: true, message: "Discarded. The uploaded file stays in storage as a record." };
  } catch (e) { return fail(e); }
}

export async function addEvidenceAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    const kind = (s(f, "kind") || "other") as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(kind)) throw new Error("Choose a kind.");
    await addEvidence(ctx, { analysisId: s(f, "analysis_id"), kind, title: s(f, "title"), storagePath: s(f, "storage_path") || null, url: s(f, "url") || null,
      sourceDate: s(f, "source_date") || null, verification: (s(f, "verification") || "unverified") as Verification, note: s(f, "note") || null });
    const back = s(f, "revalidate"); if (back.startsWith("/")) revalidatePath(back);
    return { ok: true, message: "Evidence attached." };
  } catch (e) { return fail(e); }
}

export async function setEvidenceVerificationAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    await setVerification(ctx, s(f, "id"), s(f, "verification") as Verification, s(f, "note") || null);
    const back = s(f, "revalidate"); if (back.startsWith("/")) revalidatePath(back);
    return { ok: true, message: "Verification updated." };
  } catch (e) { return fail(e); }
}

export async function generatePacksAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = toDealsCtx(await requireContext("editor"));
    const assetIds = f.getAll("asset_id").map(String).filter(Boolean);
    const r = await generatePacks(ctx, { requirementId: s(f, "requirement_id"), assetIds, preparedFor: s(f, "prepared_for") || null });
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/toolkit/packs");
  redirect(`/toolkit/packs/${id}`);
}
