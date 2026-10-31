import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { downloadDocument } from "@/modules/deals/documents/service";

/** Streams the file after checking the document row through RLS and the stored hash. */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => {
  const f = await downloadDocument(ctx, z.string().uuid().parse(p.id));
  return new Response(new Uint8Array(f.buffer), {
    headers: {
      "content-type": f.mime, "content-disposition": `attachment; filename="${f.fileName}"`,
      "x-content-sha256": f.sha256, "cache-control": "private, no-store",
    },
  });
});
