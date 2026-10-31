import { Badge, Card } from "@/components/ui";
import type { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";

type Db = Awaited<ReturnType<typeof requirePageContext>>["db"];
type Tone = "neutral" | "brand" | "ok" | "warn" | "bad" | "accent";

interface Suggestion { entity_type: string; entity_id: string; label: string; reason: string }
interface Evidence { entity_type: string; entity_id: string; basis: string; evidence: string }
interface Commitment { kind: string; who: string; what: string; due_date: string | null; due_text: string | null; task_id?: string | null }

/**
 * Inbox triage, thread view (workflow 04): one card per thread with the thread-level summary, key points, extracted
 * deadlines/commitments, evidence-backed links (organisation / opportunity) and ambiguous suggestions that were NOT linked.
 * Returns null when there are no thread summaries yet (the caller then shows the per-message list).
 */
export async function InboxThreads({ db, ws, tz, catTone }: { db: Db; ws: string; tz: string; catTone: Record<string, Tone> }) {
  const { data: threads } = await db.from("inbound_thread")
    .select("id, thread_key, subject, message_count, last_message_at, summary, key_points, latest_category, summary_status, summary_error, matched_org_ids, matched_opportunity_ids")
    .eq("workspace_id", ws).is("archived_at", null).order("last_message_at", { ascending: false }).limit(30);
  if (!threads?.length) return null;
  const keys = threads.map((t) => t.thread_key as string);
  const { data: msgs } = await db.from("inbound_message").select("thread_id, folder, from_name, from_address, received_at, triage, link_evidence, link_suggestions, commitments, is_backfill")
    .eq("workspace_id", ws).in("thread_id", keys).order("received_at");
  const byThread = new Map<string, NonNullable<typeof msgs>>();
  for (const m of msgs ?? []) byThread.set(m.thread_id as string, [...(byThread.get(m.thread_id as string) ?? []), m]);
  const orgIds = [...new Set(threads.flatMap((t) => (t.matched_org_ids ?? []) as string[]))];
  const oppIds = [...new Set(threads.flatMap((t) => (t.matched_opportunity_ids ?? []) as string[]))];
  const [{ data: orgs }, { data: opps }] = await Promise.all([
    orgIds.length ? db.from("organisation").select("id, display_name").eq("workspace_id", ws).in("id", orgIds) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    oppIds.length ? db.from("opportunity").select("id, name").eq("workspace_id", ws).in("id", oppIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const orgName = new Map((orgs ?? []).map((o) => [o.id, o.display_name as string]));
  const oppName = new Map((opps ?? []).map((o) => [o.id, o.name as string]));

  return (
    <>
      {threads.map((t) => {
        const list = byThread.get(t.thread_key as string) ?? [];
        const evidence = list.flatMap((m) => (m.link_evidence ?? []) as Evidence[]);
        const suggestions = [...new Map(list.flatMap((m) => (m.link_suggestions ?? []) as Suggestion[]).map((s) => [`${s.entity_type}:${s.entity_id}`, s])).values()]
          .filter((s) => !(t.matched_org_ids ?? []).includes(s.entity_id) && !(t.matched_opportunity_ids ?? []).includes(s.entity_id));
        const commitments = list.flatMap((m) => (m.commitments ?? []) as Commitment[]);
        const keyPoints = (t.key_points ?? []) as string[];
        const ev = (id: string) => evidence.find((e) => e.entity_id === id)?.evidence;
        return (
          <Card key={t.id}>
            <div className="flex flex-wrap items-center gap-2">
              {t.latest_category ? <Badge tone={catTone[t.latest_category] ?? "neutral"}>{String(t.latest_category).replace(/_/g, " ")}</Badge> : null}
              <Badge>{t.message_count} {t.message_count === 1 ? "message" : "messages"}</Badge>
              {t.summary_status === "failed" ? <Badge tone="bad" title={t.summary_error ?? undefined}>summary failed — showing last good one</Badge> : null}
              <span className="ml-auto text-xs text-ink-soft">{t.last_message_at ? fmt(t.last_message_at, "dd MMM, HH:mm", tz) : ""}</span>
            </div>
            <div className="mt-2 text-sm font-medium break-words">{t.subject ?? "(no subject)"}</div>
            {t.summary ? <p className="mt-1 text-sm break-words">{t.summary}</p> : <p className="mt-1 text-sm text-ink-soft">Summary pending.</p>}
            {keyPoints.length ? <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-soft">{keyPoints.map((k, i) => <li key={i} className="break-words">{k}</li>)}</ul> : null}
            {commitments.length ? (
              <div className="mt-2">
                <div className="text-xs font-medium">Deadlines &amp; commitments</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {commitments.map((c, i) => (
                    <li key={i} className="break-words">
                      <Badge tone={c.kind === "deadline" ? "warn" : "neutral"}>{c.who === "sender" ? "they promised" : c.who === "adviser" ? "asked of you" : c.kind}</Badge>{" "}
                      {c.what} · <span className="text-ink-soft">{c.due_date ? `due ${c.due_date}` : c.due_text ? `“${c.due_text}” (date unclear)` : "no date"}</span>
                      {c.task_id ? <span className="text-ink-soft"> · task created</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(t.matched_org_ids ?? []).length || (t.matched_opportunity_ids ?? []).length ? (
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {((t.matched_org_ids ?? []) as string[]).map((id) => <Badge key={id} tone="ok" title={ev(id)}>{orgName.get(id) ?? "organisation"}</Badge>)}
                {((t.matched_opportunity_ids ?? []) as string[]).map((id) => <Badge key={id} tone="brand" title={ev(id)}>{oppName.get(id) ?? "opportunity"}</Badge>)}
              </div>
            ) : null}
            {suggestions.length ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-ink-soft">Possible links not made ({suggestions.length}) — evidence was ambiguous</summary>
                <ul className="mt-1 space-y-0.5">{suggestions.map((s) => <li key={`${s.entity_type}:${s.entity_id}`} className="break-words">{s.entity_type}: <span className="font-medium">{s.label}</span> — {s.reason}</li>)}</ul>
              </details>
            ) : null}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-ink-soft">Messages</summary>
              <ul className="mt-1 space-y-1">
                {list.map((m, i) => {
                  const tr = m.triage as { summary?: string; category?: string } | null;
                  return (
                    <li key={i} className="break-words">
                      <span className="tabular-nums text-ink-soft">{fmt(m.received_at, "dd MMM HH:mm", tz)}</span>{" "}
                      {m.folder === "sent" ? "You" : m.from_name ?? m.from_address}: {m.folder === "sent" ? "(sent)" : tr?.summary ?? ""}
                      {tr?.category ? <> <Badge tone={catTone[tr.category] ?? "neutral"}>{tr.category.replace(/_/g, " ")}</Badge></> : null}
                      {m.is_backfill ? <> <Badge>history</Badge></> : null}
                    </li>
                  );
                })}
              </ul>
            </details>
          </Card>
        );
      })}
    </>
  );
}
