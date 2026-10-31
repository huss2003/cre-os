import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { importFinanceCsv, listImports, MAX_IMPORT_BYTES } from "@/modules/deals/fees/recon-service";

const Body = z.object({ fileName: z.string().min(1).max(200), text: z.string().min(1).max(MAX_IMPORT_BYTES), sourceSystem: z.string().max(100).nullish() });

/** Official finance export (CSV text) → matches, exceptions and change proposals. Idempotent per file hash. */
export const POST = dealsRoute({ mutation: true, scope: "opportunities.reconcile" }, async (req, ctx) => {
  const b = await parseJson(req, Body);
  const r = await importFinanceCsv(ctx, b);
  return { import: r.import, replayed: r.replayed };
});

export const GET = dealsRoute({}, async (_req, ctx) => ({ imports: await listImports(ctx) }));
