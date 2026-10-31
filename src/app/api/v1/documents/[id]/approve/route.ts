import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { approveDocument } from "@/modules/deals/documents/service";

export const POST = dealsRoute<{ id: string }>({ role: "admin", mutation: true, scope: "documents.approve" }, async (_req, ctx, p) =>
  ({ document: await approveDocument(ctx, z.string().uuid().parse(p.id)) }));
