import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { createSource, listSources } from "@/modules/imports/service";

/** GET /api/v1/imports/sources — approved and pending import sources (editor+). */
export const GET = route(async () => ({ sources: await listSources(await requireContext("editor")) }));

const Body = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["folder", "export", "connector", "email", "other"]).default("other"),
  location: z.string().max(300).nullish(),
  note: z.string().max(500).nullish(),
  approve: z.boolean().optional(),
});

/** POST /api/v1/imports/sources — register a source (unapproved unless an admin passes approve:true). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = Body.parse(await req.json());
  return createSource(ctx, { name: b.name, kind: b.kind, location: b.location ?? null, note: b.note ?? null, approve: b.approve });
}, { requireIdempotency: true });
