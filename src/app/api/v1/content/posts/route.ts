import type { NextRequest } from "next/server";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { listPosts, addPostIdea, PostInput } from "@/modules/intelligence/content/service";

export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const week = req.nextUrl.searchParams.get("week");
  return { posts: await guard(listPosts(ctx.db, ctx.workspaceId, week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : undefined)) };
});

export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, PostInput);
  return guard(addPostIdea(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
