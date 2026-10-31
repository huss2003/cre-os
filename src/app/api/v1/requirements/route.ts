import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { createRequirement, listRequirements } from "@/modules/deals/requirements/service";

const FieldChange = z.object({ key: z.string(), value: z.unknown().optional(), status: z.enum(["client_confirmed", "estimated", "unknown"]).optional() });
const Create = z.object({
  title: z.string().min(1).max(300), orgId: z.string().uuid().nullish(), orgName: z.string().max(300).nullish(),
  changes: z.array(FieldChange).max(60).optional(), classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).optional(),
});

export const GET = dealsRoute({}, async (req, ctx) => {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  return { requirements: await listRequirements(ctx, { status }) };
});

export const POST = dealsRoute({ mutation: true, scope: "requirements.create" }, async (req, ctx) => {
  const b = await parseJson(req, Create);
  return { requirement: await createRequirement(ctx, b) };
});
