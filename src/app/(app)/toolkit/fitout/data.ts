import "server-only";
import type { Db } from "@/lib/supabase/server";

/** Active partners for the quotation picker — no partner is special-cased. */
export async function loadPartners(db: Db, ws: string) {
  const { data } = await db.from("partner").select("id, name").eq("workspace_id", ws).eq("active", true).is("archived_at", null).order("name");
  return (data ?? []) as { id: string; name: string }[];
}
