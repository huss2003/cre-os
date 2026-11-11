/**
 * "Download deck" — generates an editable PowerPoint from the saved analysis (native charts, assumptions, missing
 * info, sources, appendix) and stores it as a new document version. Plain form POST: works without JS, at 375px.
 */
import type { Db } from "@/lib/supabase/server";
import { listDecks } from "../deck";
import { btn } from "./kit";

export function DeckButton({ analysisId, version, label = "Download deck" }: { analysisId: string; version?: number | null; label?: string }) {
  return (
    <form method="post" action={`/toolkit/deck/${analysisId}`} className="inline-flex">
      {version ? <input type="hidden" name="v" value={version} /> : null}
      <button type="submit" className={`${btn.secondary} w-full sm:w-auto`} title="Editable PowerPoint with charts, assumptions, missing information and sources">↓ {label} (.pptx)</button>
    </form>
  );
}

/** Button + the last few stored deck versions for this analysis. */
export async function DeckPanel({ db, ws, analysisId, version }: { db: Db; ws: string; analysisId: string; version?: number | null }) {
  const decks = await listDecks(db, ws, analysisId);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <DeckButton analysisId={analysisId} version={version} />
      {decks.length ? (
        <details className="text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-ink-soft">Earlier decks ({decks.length})</summary>
          <ul className="mt-1 space-y-1">{decks.map((d) => <li key={d.id}><a className={btn.link} href={`/toolkit/deck/${analysisId}?doc=${d.id}`}>Deck v{d.version_no}</a> <span className="text-xs text-ink-soft">· analysis v{d.input_versions?.analysis_version ?? "?"} · {new Date(d.created_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
