import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { setSchedule } from "@/modules/assistant/commands/service";
import { domain } from "@/modules/assistant/memory/http";

/** POST {cron, enabled, confirm} — enabling requires confirm:true (explicit authorisation). Cron is IST. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ cron: z.string().max(100).nullable().default(null), enabled: z.boolean(), confirm: z.boolean().default(false) }));
  return { command: await domain(() => setSchedule(ctx, uuid.parse(params.id), { ...b, tz: ctx.timezone || "Asia/Kolkata" })) };
}, { requireIdempotency: true });
