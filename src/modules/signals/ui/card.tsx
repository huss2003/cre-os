import Link from "next/link";
import { Badge } from "@/components/ui";
import { CATEGORY_LABEL, type Category } from "../engine";

type Row = Record<string, any>;
const tone = (b: string) => (b === "high" ? "bad" : b === "medium" ? "warn" : "neutral") as "bad" | "warn" | "neutral";
const confTone = (c: string) => (c === "high" ? "ok" : c === "medium" ? "brand" : "neutral") as "ok" | "brand" | "neutral";
export const STATUS_LABEL: Record<string, string> = { new: "New", reviewing: "Reviewing", approved: "Approved", converted: "Approved · task", rejected: "Rejected", dismissed: "Dismissed", snoozed: "Snoozed", known: "Already known" };
export const VERIFY_LABEL: Record<string, string> = { fact: "Fact", inference: "Reported", hypothesis: "Hypothesis", unknown: "Unknown" };

export function SignalCard({ s }: { s: Row }) {
  const who = s.org?.display_name ?? s.person?.full_name ?? s.entity_name_raw ?? "Unresolved";
  return (
    <Link href={`/signals/${s.id}`} className="block rounded-xl border border-line bg-surface p-4 hover:border-brand">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone(s.priority_band)} title={(s.priority_reasons ?? []).join(" ")}>{s.priority_band} priority</Badge>
        <Badge>{CATEGORY_LABEL[s.category as Category] ?? s.category}</Badge>
        <Badge tone={confTone(s.confidence)}>Evidence: {s.confidence}</Badge>
        <Badge>{VERIFY_LABEL[s.verification] ?? s.verification}</Badge>
        <Badge>{STATUS_LABEL[s.status] ?? s.status}</Badge>
        {!s.org_id && !s.person_id ? <Badge tone="warn">Company not matched</Badge> : null}
      </div>
      <p className="mt-2 font-medium">{s.title}</p>
      <p className="text-sm text-ink-soft">{who}{s.location_text ? ` · ${s.location_text}` : ""} · detected {String(s.detected_at).slice(0, 10)}{s.event_date ? ` · event ${s.event_date}` : ""}</p>
      {s.recommended_action ? <p className="mt-2 text-sm"><span className="font-medium">Next: </span>{s.recommended_action}</p> : null}
    </Link>
  );
}
