import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import type { EngineMeta } from "../service";
import { ObservationList } from "./observations";
import { TIER_TONE } from "./labels";
import { INTENT_LABEL, type Intent } from "../analysis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const KIND_ICON: Record<string, string> = { saved: "✓", matched: "↔", proposed: "＋", questioned: "?", scheduled: "⏰", changed: "≠", duplicate: "⧉", failed: "!" };

/** Plain-language receipt + understanding (intents, matches with confidence) + extracted items + correction history. */
export function EnginePanel({ engine, observations, corrections, editor, original, linkOptions }: {
  engine: EngineMeta | null; observations: Row[]; corrections: Row[]; editor: boolean; original?: string | null; linkOptions?: { value: string; label: string }[];
}) {
  return (
    <>
      {engine ? (
        <Card title="Receipt" help="What CRE OS did with this capture, in plain words. Nothing material changes on a record until it is approved.">
          <ul className="space-y-1 text-sm">
            {engine.receipt.lines.map((l, i) => (
              <li key={i} className={l.kind === "failed" ? "text-bad" : l.kind === "questioned" || l.kind === "changed" ? "text-warn" : ""}>
                <span aria-hidden className="mr-2 inline-block w-4 text-center">{KIND_ICON[l.kind] ?? "•"}</span>{l.text}
              </li>
            ))}
          </ul>
          {engine.intents.length ? <div className="mt-3 flex flex-wrap gap-1">{engine.intents.map((i) => <Badge key={i}>{INTENT_LABEL[i as Intent] ?? i}</Badge>)}</div> : null}
          {engine.matches.length ? (
            <ul className="mt-3 space-y-1 text-xs">
              {engine.matches.map((m) => (
                <li key={m.mention_index} className="flex flex-wrap items-center gap-2">
                  <Badge tone={TIER_TONE[m.tier]}>{m.tier === "none" ? "no match" : `${m.tier} confidence`}</Badge>
                  <span>{m.kind}: “{m.text}”{m.label && m.label !== m.text ? ` → ${m.label}` : ""}</span><span className="text-ink-soft">{m.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {engine.auto_answers.length ? <p className="mt-2 text-xs text-ink-soft">Weekday follow-ups were set to the next occurrence (workspace time zone). Change them below if needed.</p> : null}
          <p className="mt-2 text-xs text-ink-soft">Processed {fmt(engine.ran_at)}{engine.duplicate_of ? <> · same as <Link className="text-brand" href={`/capture/${engine.duplicate_of}`}>an earlier capture</Link></> : null}</p>
        </Card>
      ) : null}
      {original ? (
        <Card title="Original (Hindi)" help="The transcript as received. CRE OS reads a romanised copy; correct the note above if a word was misheard.">
          <p className="whitespace-pre-wrap text-sm" lang="hi">{original}</p>
        </Card>
      ) : null}
      <Card title={`Extracted information (${observations.length})`} help="Each item keeps the original wording and where it came from. Estimates, assumptions and hypotheses are never treated as confirmed facts.">
        <ObservationList items={observations} editor={editor} linkOptions={linkOptions} />
      </Card>
      {corrections.length ? (
        <Card title="Correction history">
          <ul className="space-y-1 text-xs">
            {corrections.map((c) => (
              <li key={c.id}><span className="text-ink-soft">{fmt(c.created_at)}</span> — {c.target}: {JSON.stringify(c.before)} → {JSON.stringify(c.after)}{c.note ? ` (${c.note})` : ""}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
