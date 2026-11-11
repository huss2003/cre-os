import Link from "next/link";
import type { Db } from "@/lib/supabase/server";
import { provenanceLinks } from "./trace";

/** "Source" (import trace) and "From capture" links for company / person / building pages. Renders nothing when there is no evidence. */
export async function ProvenanceLinks({ db, workspaceId, entityId }: { db: Db; workspaceId: string; entityId: string }) {
  const p = await provenanceLinks(db, workspaceId, entityId).catch(() => null);
  if (!p || (!p.importRows && !p.capture.count)) return null;
  return (
    <p className="flex flex-wrap gap-3 text-sm">
      {p.importRows ? <Link className="text-brand underline" href={`/imports/source/${entityId}`}>Source ({p.importRows} spreadsheet row{p.importRows === 1 ? "" : "s"})</Link> : null}
      {p.capture.count && p.capture.href ? <Link className="text-brand underline" href={p.capture.href}>From capture ({p.capture.count} observation{p.capture.count === 1 ? "" : "s"})</Link> : null}
    </p>
  );
}
