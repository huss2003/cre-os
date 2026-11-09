import { requireContext } from "@/lib/auth/context";
import { briefMarkdown } from "@/modules/meetings/service";

/** Export the current brief as Markdown (internal use; never sent anywhere). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext("viewer");
  const { data } = await ctx.db.from("meeting_prep").select("brief, brief_version").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!data?.brief) return new Response("No brief yet", { status: 404 });
  return new Response(briefMarkdown(data.brief), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="meeting-brief-v${data.brief_version}.md"` } });
}
