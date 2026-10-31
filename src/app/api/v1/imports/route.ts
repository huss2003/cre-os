import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { MAX_IMPORT_BYTES } from "@/modules/imports/pipeline";
import { listBatches, uploadImport } from "@/modules/imports/service";

const Options = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  period_year: z.coerce.number().int().min(1990).max(2100).nullish(),
  classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).nullish(),
  source_id: z.string().uuid().nullish(),
  source_name: z.string().trim().min(2).max(120).nullish(),
  source_kind: z.enum(["folder", "export", "connector", "email", "other"]).nullish(),
});

/** GET /api/v1/imports — recent batches with reconciliation numbers. */
export const GET = route(async () => {
  const ctx = await requireContext("editor");
  return { batches: await listBatches(ctx) };
});

/**
 * POST /api/v1/imports (multipart: file, as_of?, period_year?, classification?, source_id? | source_name? + source_kind?) — editor+.
 * Unknown source names are registered unapproved and the batch is quarantined (status awaiting_source) until an admin approves it.
 * Hashes and stores the original read-only; identical hash => no-op; same name + new hash => new version with diff.
 * Enqueues job imports.process and processes inline for immediate reconciliation.
 */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new HttpError(400, "multipart field 'file' is required");
  if (file.size > MAX_IMPORT_BYTES) throw new HttpError(413, "file too large (25 MB max)");
  const blank = (v: FormDataEntryValue | null) => (v === null || v === "" ? null : String(v));
  const sid = blank(form.get("source_id"));
  const opts = Options.parse({ as_of: blank(form.get("as_of")), period_year: blank(form.get("period_year")), classification: blank(form.get("classification")),
    source_id: sid === "new" ? null : sid, source_name: blank(form.get("source_name")), source_kind: blank(form.get("source_kind")) });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadImport(ctx, { name: file.name, bytes }, {
    as_of: opts.as_of ?? null, period_year: opts.period_year ?? null, classification: opts.classification ?? undefined,
    source: opts.source_id ? { id: opts.source_id } : opts.source_name ? { name: opts.source_name, kind: opts.source_kind ?? "other" } : null,
  });
}, { requireIdempotency: true });
