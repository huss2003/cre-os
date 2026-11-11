import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { MAX_IMPORT_BYTES } from "@/modules/imports/pipeline";
import { MAX_RUN_FILES } from "@/modules/imports/runs";
import { importRuns, uploadRun } from "@/modules/imports/service";

const Options = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  period_year: z.coerce.number().int().min(1990).max(2100).nullish(),
  classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).nullish(),
  source_id: z.string().uuid().nullish(),
  label: z.string().trim().max(120).nullish(),
});

/** GET /api/v1/imports/runs — recent multi-file batches with progress + completion report. */
export const GET = route(async () => {
  const ctx = await requireContext("editor");
  return { runs: await importRuns(ctx) };
});

/**
 * POST /api/v1/imports/runs (multipart: files[] (repeat "files"), as_of?, period_year?, classification?, source_id?, label?) — editor+.
 * Registers every file (spreadsheets → imports, documents/images → captures) and queues background processing; returns at once.
 * A failing file never blocks the others. Same Idempotency-Key => same run.
 */
export const POST = route(async (req, { idempotencyKey }) => {
  const ctx = await requireContext("editor");
  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("files") ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  if (!form || !files.length) throw new HttpError(400, "multipart field 'files' is required");
  if (files.length > MAX_RUN_FILES) throw new HttpError(400, `at most ${MAX_RUN_FILES} files per batch`);
  const blank = (v: FormDataEntryValue | null) => (v === null || v === "" || v === "new" ? null : String(v));
  const o = Options.parse({ as_of: blank(form.get("as_of")), period_year: blank(form.get("period_year")), classification: blank(form.get("classification")),
    source_id: blank(form.get("source_id")), label: blank(form.get("label")) });
  const payload = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, tooLarge: f.size > MAX_IMPORT_BYTES, bytes: f.size > MAX_IMPORT_BYTES ? new Uint8Array(0) : new Uint8Array(await f.arrayBuffer()) })));
  return uploadRun(ctx, payload, {
    as_of: o.as_of ?? null, period_year: o.period_year ?? null, classification: o.classification ?? undefined, source: o.source_id ? { id: o.source_id } : null,
  }, idempotencyKey, o.label ?? null);
}, { requireIdempotency: true });
