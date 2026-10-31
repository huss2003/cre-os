import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { brandRules, confidentialTerms, saveBrandRules, saveConfidentialTerms } from "@/modules/intelligence/content/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  const [rules, terms] = await Promise.all([brandRules(ctx.db, ctx.workspaceId), confidentialTerms(ctx.db, ctx.workspaceId)]);
  return { brandRules: rules, confidentialTerms: terms };
});

const Body = z.object({ brandRules: z.array(z.string().max(300)).max(30).optional(), confidentialTerms: z.array(z.string().max(300)).max(200).optional() });

/** Admin-only guardrails: brand rules + confidential terms (workspace_setting content.brand_rules / content.confidential_terms). */
export const POST = route(async (req) => {
  const ctx = await requireContext("admin");
  const b = await parseJson(req, Body);
  return {
    brandRules: b.brandRules ? await guard(saveBrandRules(ctx.db, ctx.workspaceId, b.brandRules)) : await brandRules(ctx.db, ctx.workspaceId),
    confidentialTerms: b.confidentialTerms ? await guard(saveConfidentialTerms(ctx.db, ctx.workspaceId, b.confidentialTerms)) : await confidentialTerms(ctx.db, ctx.workspaceId),
  };
}, { requireIdempotency: true });
