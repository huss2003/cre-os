import Link from "next/link";
import { FreshnessBadge, type Freshness } from "@/modules/changes/ui/steward-ui";

type Db = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Freshness flag (from the Database Steward's stale-record detector) + a link to the per-field
 * "why do we believe this" evidence view. Server Component; RLS applies through the caller's db.
 */
export async function RecordTrust({ db, workspaceId, type, id }: { db: Db; workspaceId: string; type: "organisation" | "person" | "asset"; id: string }) {
  const { data } = await db.from("record_freshness")
    .select("status, last_verified_at, basis, window_days, stale_since")
    .eq("workspace_id", workspaceId).eq("entity_type", type).eq("entity_id", id).is("archived_at", null)
    .maybeSingle();
  return (
    <>
      <FreshnessBadge f={(data ?? null) as Freshness | null} />
      <Link className="text-brand underline-offset-2 hover:underline" href={`/approvals/evidence?type=${type}&id=${id}`}>Why do we believe this?</Link>
    </>
  );
}
