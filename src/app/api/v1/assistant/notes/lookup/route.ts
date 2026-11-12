import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { lookupEntities, lookupById } from "@/modules/assistant/notes/lookup";

const Q = z.object({
  kind: z.enum(["company", "requirement", "meeting", "person", "lease", "transaction"]),
  q: z.string().max(100).default(""),
  orgId: z.string().uuid().optional(),
  id: z.string().uuid().optional(),
});

/** GET /api/v1/assistant/notes/lookup?kind=company|requirement|meeting|person|lease|transaction&q=&orgId=&id= — picker search (RLS + workspace filter). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  const p = Q.parse({ kind: sp.get("kind"), q: sp.get("q") ?? "", orgId: sp.get("orgId") || undefined, id: sp.get("id") || undefined });
  const c = { db: ctx.db, workspaceId: ctx.workspaceId };
  if (p.id) { const it = await lookupById(c, p.kind, p.id); return { items: it ? [it] : [] }; }
  return { items: await lookupEntities(c, p.kind, p.q, { orgId: p.orgId }) };
});
