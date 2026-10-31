import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { generateDossier } from "@/modules/intelligence/research/service";
import { dossierPage } from "@/modules/intelligence/research/queries";

type P = { orgId: string };

export const GET = route<P>(async (_req, { params }) => {
  const ctx = await requireContext();
  const orgId = uuid.parse(params.orgId);
  return guard(dossierPage(ctx.db, ctx.workspaceId, orgId));
});

/** Regenerate when evidence changed or the tier interval elapsed (force=true to rebuild). Re-running is idempotent. */
export const POST = route<P>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const orgId = uuid.parse(params.orgId);
  const b = await parseJson(req, z.object({ force: z.boolean().default(false) }));
  const r = await guard(generateDossier(ctx.db, ctx.workspaceId, orgId, { force: b.force, userId: ctx.userId }));
  return { status: r.status, reason: r.reason, synthesis_status: r.synthesis_status ?? r.dossier.synthesis_status, degraded_reason: r.degraded_reason ?? null, dossier: r.dossier };
}, { requireIdempotency: true });
