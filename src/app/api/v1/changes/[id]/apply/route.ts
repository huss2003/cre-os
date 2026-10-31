import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { applyChange } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

/** POST — apply (row lock, version check, approval hash/expiry check, audit) in one transaction. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  try { return await applyChange(ctx.db, uuid.parse(params.id)); } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
