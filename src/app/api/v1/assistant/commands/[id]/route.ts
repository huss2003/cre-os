import { HttpError, requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { getCommand, updateCommand, archiveCommand, commandFields } from "@/modules/assistant/commands/service";
import { domain } from "@/modules/assistant/memory/http";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const c = await getCommand(ctx, uuid.parse(params.id));
  if (!c) throw new HttpError(404, "command not found");
  return { command: c };
});
/** PATCH — edit; bumps version. Changing the prompt of a scheduled command revokes its authorisation. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, commandFields.partial());
  return { command: await domain(() => updateCommand(ctx, uuid.parse(params.id), b)) };
}, { requireIdempotency: true });
/** DELETE — archive (run history kept). */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  await domain(() => archiveCommand(ctx, uuid.parse(params.id)));
  return { ok: true };
}, { requireIdempotency: true });
