import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { MAX_IMPORT_BYTES } from "@/modules/imports/pipeline";
import { listBatches, uploadImport } from "@/modules/imports/service";

const Options = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  period_year: z.coerce.number().int().min(1990).max(2100).nullish(),
  classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).nullish(),
});

/** GET /api/v1/imports — recent batches with reconciliation numbers. */
export const GET = route(async () => {
  const ctx = await requireContext("editor");
  return { batches: await listBatches(ctx) };
});

/**
 * POST /api/v1/imports (multipart: file, as_of?, period_year?, classification?) — editor+.
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
  const opts = Options.parse({ as_of: blank(form.get("as_of")), period_year: blank(form.get("period_year")), classification: blank(form.get("classification")) });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadImport(ctx, { name: file.name, bytes }, {
    as_of: opts.as_of ?? null, period_year: opts.period_year ?? null, classification: opts.classification ?? undefined,
  });
}, { requireIdempotency: true });
