import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { openFindings } from "@/modules/intelligence/research/queries";
import { runPatrol } from "@/modules/intelligence/research/patrol-service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { findings: await guard(openFindings(ctx.db, ctx.workspaceId, 200)) };
});

/** Run the evidence patrol over records visible to the caller. Findings are deduped by key. */
export const POST = route(async () => {
  const ctx = await requireContext("editor");
  return guard(runPatrol(ctx.db, ctx.workspaceId));
}, { requireIdempotency: true });
