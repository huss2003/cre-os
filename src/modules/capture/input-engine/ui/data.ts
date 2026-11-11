import "server-only";
import type { Db } from "@/lib/supabase/server";
import { linkOptions } from "../../docs/service";
import { correctionsFor, observationsFor, type EngineMeta } from "../service";

/** Review-screen data for the Input Engine panel (user client; RLS applies). */
export async function engineData(db: Db, ws: string, captureId: string, editor: boolean) {
  const [{ data: row }, observations, corrections, opts] = await Promise.all([
    db.from("capture").select("ie:extraction->meta->input_engine, original:extraction->meta->original_transcript").eq("workspace_id", ws).eq("id", captureId).maybeSingle(),
    observationsFor(db, ws, { captureId }), correctionsFor(db, ws, captureId), editor ? linkOptions(db, ws) : null,
  ]);
  return {
    engine: ((row as { ie?: EngineMeta } | null)?.ie ?? null) as EngineMeta | null,
    original: ((row as { original?: string } | null)?.original ?? null) as string | null,
    observations, corrections, links: opts ? flatLinks(opts) : undefined,
  };
}

export function flatLinks(o: Awaited<ReturnType<typeof linkOptions>>) {
  return [
    ...o.requirement.map((x) => ({ value: `requirement:${x.id}`, label: `Requirement · ${x.label}` })),
    ...o.organisation.map((x) => ({ value: `organisation:${x.id}`, label: `Company · ${x.label}` })),
    ...o.person.map((x) => ({ value: `person:${x.id}`, label: `Contact · ${x.label}` })),
    ...o.asset.map((x) => ({ value: `asset:${x.id}`, label: `Building · ${x.label}` })),
  ];
}
