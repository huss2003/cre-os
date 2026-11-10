import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { commandHistory } from "@/modules/assistant/commands/service";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  return { items: await commandHistory(ctx, uuid.parse(params.id)) };
});
