import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { releaseDocument } from "@/modules/deals/documents/service";

const Body = z.object({ recipient: z.string().min(2).max(300) });

/** Client-ready release: freshness + quote leakage checks. Nothing is sent — the user shares the file manually (S3). */
export const POST = dealsRoute<{ id: string }>({ role: "admin", mutation: true, scope: "documents.release" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return releaseDocument(ctx, z.string().uuid().parse(p.id), b);
});
