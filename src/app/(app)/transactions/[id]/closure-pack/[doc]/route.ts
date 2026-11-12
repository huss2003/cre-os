import { requireContext } from "@/lib/auth/context";
import { downloadClosurePack } from "@/modules/transactions/closure-pack";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; doc: string }> }) {
  const { doc } = await params;
  try {
    const app = await requireContext();
    const buf = await downloadClosurePack({ db: app.db, workspaceId: app.workspaceId, userId: app.userId }, doc);
    return new Response(new Uint8Array(buf), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="closure-pack.docx"`, "cache-control": "private, no-store" } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Not found", { status: 404 });
  }
}
