import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { listMemories, saveMemory, CATEGORIES } from "@/modules/assistant/memory/service";
import { domain } from "@/modules/assistant/memory/http";

/** GET /api/v1/assistant/memory?category=&entity=&status=&q= — memories with history and stale flag. */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  const category = z.enum(CATEGORIES as [string, ...string[]]).optional().parse(sp.get("category") || undefined) as "person" | undefined;
  const status = z.enum(["active", "restricted", "outdated", "forgotten", "all"]).optional().parse(sp.get("status") || undefined);
  const entity = sp.get("entity") ? uuid.parse(sp.get("entity")) : undefined;
  return { items: await listMemories(ctx, { category, status, entityId: entity, q: sp.get("q") ?? undefined }) };
});

const body = z.object({
  category: z.enum(["person", "company", "requirement", "relationship"]),
  entity_type: z.enum(["person", "company", "organisation", "requirement"]), entity_id: uuid,
  content: z.string().min(3).max(1000), stated: z.boolean().default(true), confidence: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["normal", "confidential", "restricted"]).default("normal"), company_specific: z.boolean().default(false),
  provided_by: z.string().max(120).optional(), review_at: z.string().date().optional(),
});
/** POST /api/v1/assistant/memory — save a memory (user-entered). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, body);
  const m = await domain(() => saveMemory(ctx, { category: b.category, entityType: b.entity_type, entityId: b.entity_id, content: b.content, stated: b.stated, confidence: b.confidence, sensitivity: b.sensitivity, scope: b.company_specific ? "employer" : undefined, providedBy: b.provided_by ?? "user", reviewAt: b.review_at ?? null, source: "user" }));
  return { memory: m };
}, { requireIdempotency: true });
