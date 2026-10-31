import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { recordRelationship, relationshipsForPerson, RelationshipInput } from "@/modules/intelligence/network/relationships";

/** Relationships touching a person, with introduction-consent records. */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const personId = uuid.parse(req.nextUrl.searchParams.get("personId"));
  return { relationships: await guard(relationshipsForPerson(ctx.db, ctx.workspaceId, personId, ctx.userId)) };
});

/** Record (or update) who knows whom. Never sets intro permission. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, RelationshipInput);
  return guard(recordRelationship(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
