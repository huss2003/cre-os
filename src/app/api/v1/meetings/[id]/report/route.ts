import { requireContext } from "@/lib/auth/context";
import { MeetingError } from "@/modules/meetings/service";
import { meetingReportMarkdown } from "@/modules/meetings/more";

/** Internal meeting report as Markdown (internal use; never sent anywhere). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext("viewer");
  try {
    const md = await meetingReportMarkdown(ctx.db, ctx.workspaceId, id);
    return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="meeting-report-${id.slice(0, 8)}.md"` } });
  } catch (e) {
    if (e instanceof MeetingError) return new Response(e.message, { status: 404 });
    throw e;
  }
}
