import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { must } from "@/modules/deals/ctx";

/** Version history of a document family (every version the caller may see, newest first). */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => {
  const doc = must(await ctx.db.from("document_version").select("family_id").eq("id", z.string().uuid().parse(p.id)).maybeSingle(), "document") as { family_id: string | null };
  const r = await ctx.db.from("document_version").select("id, version_no, parent_id, status, sha256, approved_hash, released_at, stale_reasons, created_at, input_versions->sources")
    .eq("family_id", doc.family_id ?? p.id).order("version_no", { ascending: false });
  return { familyId: doc.family_id, versions: r.data ?? [] };
});
