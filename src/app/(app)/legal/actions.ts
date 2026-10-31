"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { addLegalDocument, compareDocuments } from "@/modules/intelligence/legal/service";

export async function addDocumentAction(form: FormData) {
  await formAction("/legal", "editor", async (ctx) => {
    const r = await addLegalDocument(ctx.db, ctx.workspaceId, {
      title: str(form, "title") ?? "", docKind: (str(form, "doc_kind") ?? "loi") as never, familyKey: str(form, "family_key"), text: str(form, "text") ?? "",
      ocrUnverified: form.get("ocr_unverified") === "on",
    }, { userId: ctx.userId });
    if (r.duplicate) return { notice: "Identical text already stored — showing the existing version.", to: `/legal/${r.document.id}` };
    return { notice: `Version ${r.document.version} stored; ${r.clauseCount} clause(s) extracted (${r.method}). Review each clause against the source.`, to: `/legal/${r.document.id}` };
  });
}

export async function compareAction(form: FormData) {
  await formAction("/legal", "editor", async (ctx) => {
    const base = str(form, "base_id"), next = str(form, "compare_id");
    if (!base || !next || base === next) throw new Error("Choose two different documents.");
    const c = await compareDocuments(ctx.db, ctx.workspaceId, base, next, ctx.userId);
    return { notice: "Redline ready — for the tenant's legal team, not legal advice.", to: `/legal/compare/${c.id}` };
  });
}
