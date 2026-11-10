import { requireContext } from "@/lib/auth/context";
import { downloadDeliverable } from "@/modules/toolkit/deliverables";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  try {
    const app = await requireContext();
    const f = await downloadDeliverable(app.db, app.workspaceId, id, decodeURIComponent(file));
    return new Response(new Uint8Array(f.buffer), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.fileName}"`, "cache-control": "private, no-store" } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Not found", { status: 404 });
  }
}
