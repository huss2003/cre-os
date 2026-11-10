import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { duplicateCommand } from "@/modules/assistant/commands/service";
import { domain } from "@/modules/assistant/memory/http";

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  return { command: await domain(() => duplicateCommand(ctx, uuid.parse(params.id))) };
}, { requireIdempotency: true });
