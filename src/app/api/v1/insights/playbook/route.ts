import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { addPlaybookItem, PlaybookInput } from "@/modules/intelligence/insights/service";

export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, PlaybookInput);
  return guard(addPlaybookItem(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
