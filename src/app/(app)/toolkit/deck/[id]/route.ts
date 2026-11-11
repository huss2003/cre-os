import { requireContext } from "@/lib/auth/context";
import { downloadDeck, generateDeck } from "@/modules/toolkit/deck";

const fail = (e: unknown, status = 400) => new Response(e instanceof Error ? e.message : "Could not make the deck.", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const attach = (buf: Buffer, mime: string, name: string) => new Response(new Uint8Array(buf), { headers: { "content-type": mime, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });

/** POST = generate a new deck version from the saved analysis (optional form field `v` = analysis version) and download it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const app = await requireContext("editor");
    const form = await req.formData().catch(() => null);
    const v = Number(form?.get("v") ?? "") || null;
    const d = await generateDeck(app.db, app.workspaceId, app.userId, id, v);
    return attach(d.buffer, "application/vnd.openxmlformats-officedocument.presentationml.presentation", d.fileName);
  } catch (e) { return fail(e); }
}

/** GET ?doc=<document_version id> = download a stored deck again (sha256 re-checked). */
export async function GET(req: Request) {
  try {
    const app = await requireContext();
    const doc = new URL(req.url).searchParams.get("doc");
    if (!doc) return fail(new Error("Missing document id."));
    const f = await downloadDeck(app.db, app.workspaceId, doc);
    return attach(f.buffer, f.mime, f.fileName);
  } catch (e) { return fail(e, 404); }
}
