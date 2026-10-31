import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { listSources, saveSource } from "@/modules/intelligence/research/registry";
import { SourceInput } from "@/modules/intelligence/research/sources";

/** Approved research sources (registry). */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { sources: await guard(listSources(ctx.db, ctx.workspaceId)) };
});

/** Add an approved source (admin). Same name => the existing source is returned (replay-safe). */
export const POST = route(async (req) => {
  const ctx = await requireContext("admin");
  const b = await parseJson(req, SourceInput);
  return guard(saveSource(ctx.db, ctx.workspaceId, b, { userId: ctx.userId }));
}, { requireIdempotency: true });
