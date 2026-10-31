"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { HttpError, requireContext } from "@/lib/auth/context";
import { approveMappingAndReprocess, closeException, decideCandidate, reprocess } from "@/modules/imports/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (form: FormData, key: string) => {
  const v = String(form.get(key) ?? "");
  if (!UUID.test(v)) throw new HttpError(400, `invalid ${key}`);
  return v;
};

/** Run a mutation, then come back to the batch page (with the error message when it failed). */
async function run(batchId: string, fn: () => Promise<unknown>): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = e instanceof HttpError ? e.message : e instanceof Error ? e.message : "action failed";
  }
  revalidatePath(`/imports/${batchId}`);
  revalidatePath("/imports");
  redirect(`/imports/${batchId}${error ? `?error=${encodeURIComponent(error)}` : ""}`);
}

export async function reprocessAction(form: FormData) {
  const batchId = id(form, "batch_id");
  await run(batchId, async () => reprocess(await requireContext("editor"), batchId));
}

export async function resolveExceptionAction(form: FormData) {
  const batchId = id(form, "batch_id");
  const status = form.get("status") === "dismissed" ? "dismissed" : "resolved";
  const note = String(form.get("note") ?? "").trim().slice(0, 2000) || null;
  await run(batchId, async () => closeException(await requireContext("editor"), id(form, "exception_id"), status, note));
}

export async function decideMatchAction(form: FormData) {
  const batchId = id(form, "batch_id");
  const d = String(form.get("decision"));
  const decision = d === "link" || d === "related" ? d : "keep_separate";
  await run(batchId, async () => decideCandidate(await requireContext("editor"), id(form, "candidate_id"), decision));
}

export async function approveMappingAction(form: FormData) {
  const batchId = id(form, "batch_id");
  await run(batchId, async () => {
    const ctx = await requireContext("admin");
    let columnMap: Record<string, number> = {};
    try {
      const raw = JSON.parse(String(form.get("column_map") ?? "{}")) as Record<string, unknown>;
      columnMap = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => [k, Number(v)]));
    } catch {
      throw new HttpError(400, "invalid column map");
    }
    const [adapter, role] = String(form.get("adapter_role") ?? "").split(":");
    return approveMappingAndReprocess(ctx, {
      batchId, sheet: String(form.get("sheet") ?? ""), adapter, role, columnMap,
      positional: form.get("positional") === "true", headerRow: Number(form.get("header_row") ?? 0),
      note: String(form.get("note") ?? "").trim() || undefined,
    });
  });
}
