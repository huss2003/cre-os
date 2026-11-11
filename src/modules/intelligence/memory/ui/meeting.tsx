/**
 * Module 13 §7.2 — renders `brief.content.memory` (from meetingMemoryForBrief) on the meeting page. Every line links to
 * its source where one exists; anything missing is shown as unknown, never filled in. Tolerates older brief shapes.
 */
import Link from "next/link";
import type { ReactNode } from "react";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const d = (s: unknown) => (s ? String(s).slice(0, 10) : "date unknown");
const txt = (x: unknown): { text: string; href: string | null } => (typeof x === "string" ? { text: x, href: null } : { text: String((x as Row)?.text ?? ""), href: ((x as Row)?.href as string) ?? null });
const SrcLink = ({ href, label = "source" }: { href?: string | null; label?: string }) =>
  href ? <Link className="text-xs text-brand underline" href={href}>{label}</Link> : <span className="text-xs text-ink-soft">no source link</span>;

function Block({ title, items, empty, children }: { title: string; items: unknown[] | null | undefined; empty: string; children?: ReactNode }) {
  const n = items?.length ?? 0;
  return (
    <details className="min-w-0 border-b border-line" open={n > 0 && n <= 5}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-[15px] font-medium"><span>{title}</span><span className="text-sm font-normal text-ink-soft">{n || "unknown"}</span></summary>
      <div className="pb-3 text-sm">{n ? children : <p className="text-ink-soft">{empty}</p>}</div>
    </details>
  );
}

export function MeetingMemory({ memory }: { memory: Row | null | undefined }) {
  if (!memory) return <p className="rounded-xl bg-surface px-4 py-3 text-sm text-ink-soft">History from your records is unavailable for this brief — press Regenerate to include it.</p>;
  const m = memory;
  const li = "break-words";
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs text-ink-soft">{m.note ?? "From recorded history only. Anything not listed is unknown."}</p>
      <Block title="Attendees & current designation" items={[...(m.attendees ?? []), ...(m.unmatchedAttendees ?? [])]} empty="No attendee linked to a contact — unknown.">
        <ul className="space-y-1">
          {(m.attendees ?? []).map((a: Row, k: number) => <li key={k} className={li}>{a.href ? <Link className="text-brand" href={a.href}>{a.name}</Link> : a.name} · {a.designation ?? "Designation unknown"}{a.company ? ` at ${a.company}` : ""} <span className="text-xs text-ink-soft">· relationship {a.relationship ?? "unknown"} · {a.previousInteractions ?? 0} past interactions · last {a.lastDiscussion ? d(a.lastDiscussion.at) : "never recorded"}</span></li>)}
          {(m.unmatchedAttendees ?? []).map((n: string, k: number) => <li key={`u${k}`} className="text-ink-soft">{n} · not linked to a contact — designation unknown</li>)}
        </ul>
      </Block>
      <Block title="Last discussion" items={m.lastDiscussion ? [m.lastDiscussion] : []} empty="Unknown — no earlier conversation recorded.">
        {m.lastDiscussion ? <p className={li}>{d(m.lastDiscussion.at)} · {m.lastDiscussion.subject ?? "(no subject)"}{m.lastDiscussion.summary ? ` — ${m.lastDiscussion.summary}` : ""} <SrcLink href={m.lastDiscussion.href} /></p> : null}
      </Block>
      <Block title="Pending commitments" items={m.pendingCommitments} empty="None recorded.">
        <ul className="space-y-1">{(m.pendingCommitments ?? []).map((c: Row, k: number) => <li key={k} className={li}>{c.text}{c.due ? ` · due ${c.due}` : " · due date unknown"}{c.overdue ? <span className="ml-1 text-bad">overdue</span> : null} <SrcLink href={c.source?.href} label={c.source?.label ?? "source"} /></li>)}</ul>
      </Block>
      <Block title="Requirements" items={m.requirements} empty="Unknown — no live requirement linked.">
        <ul className="space-y-1">{(m.requirements ?? []).map((r: Row, k: number) => <li key={k} className={li}><Link className="text-brand" href={r.href ?? `/requirements/${r.id}`}>{r.title}</Link>{r.summary ? <span className="text-ink-soft"> — {r.summary}</span> : <span className="text-ink-soft"> — details unknown</span>}</li>)}</ul>
      </Block>
      <Block title="Objections raised" items={m.objections} empty="None recorded.">
        <ul className="space-y-1">{(m.objections ?? []).map((o: Row, k: number) => <li key={k} className={li}>“{o.text}” <span className="text-xs text-ink-soft">{d(o.at)}</span> <SrcLink href={o.source?.href} label={o.source?.label ?? "source"} /></li>)}</ul>
      </Block>
      <Block title="Commercial discussions" items={m.commercialDiscussions} empty="No quotes or offers recorded — commercial terms unknown.">
        <ul className="space-y-1">{(m.commercialDiscussions ?? []).map((c: Row, k: number) => <li key={k} className={li}>{c.asset ?? "Building unknown"}: {c.text} <SrcLink href={c.href} /></li>)}</ul>
      </Block>
      <Block title="Pending questions" items={m.pendingQuestions} empty="No open mandatory questions recorded.">
        <ul className="space-y-1">{(m.pendingQuestions ?? []).map(txt).map((x: { text: string; href: string | null }, k: number) => <li key={k} className={li}>{x.text} <SrcLink href={x.href} /></li>)}</ul>
      </Block>
      <Block title="Recent developments" items={m.developments} empty="None recorded.">
        <ul className="space-y-1">{(m.developments ?? []).map((x: Row, k: number) => <li key={k} className={li}>{d(x.at)} · {x.title} <span className={`text-xs ${x.verified ? "text-ok" : "text-warn"}`}>{x.verified ? "verified" : "unverified"}</span> <SrcLink href={x.href} /></li>)}</ul>
      </Block>
      <Block title="Suggested discussion points" items={m.suggestedPoints} empty="Nothing suggested from the records.">
        <ul className="space-y-1">{(m.suggestedPoints ?? []).map(txt).map((x: { text: string; href: string | null }, k: number) => <li key={k} className={li}>{x.text} <SrcLink href={x.href} label="timeline" /></li>)}</ul>
      </Block>
    </div>
  );
}

/** Markdown lines for the brief export. */
export function meetingMemoryMarkdown(m: Row | null | undefined): string[] {
  if (!m) return [];
  const L = ["## From your records", `_${m.note ?? "From recorded history only. Anything not listed is unknown."}_`];
  const sec = (t: string, xs: string[], empty: string) => L.push(`### ${t}`, ...(xs.length ? xs.map((x) => `- ${x}`) : [`- ${empty}`]));
  sec("Attendees", [...(m.attendees ?? []).map((a: Row) => `${a.name} — ${a.designation ?? "designation unknown"}${a.company ? ` at ${a.company}` : ""}`), ...(m.unmatchedAttendees ?? []).map((n: string) => `${n} — designation unknown`)], "Unknown");
  sec("Last discussion", m.lastDiscussion ? [`${d(m.lastDiscussion.at)} ${m.lastDiscussion.subject ?? ""}`] : [], "Unknown");
  sec("Pending commitments", (m.pendingCommitments ?? []).map((c: Row) => `${c.text}${c.due ? ` (due ${c.due})` : ""} [${c.source?.label ?? "source"}]`), "None recorded");
  sec("Requirements", (m.requirements ?? []).map((r: Row) => `${r.title}: ${r.summary || "unknown"}`), "Unknown");
  sec("Objections", (m.objections ?? []).map((o: Row) => `"${o.text}" (${d(o.at)})`), "None recorded");
  sec("Commercial discussions", (m.commercialDiscussions ?? []).map((c: Row) => c.text), "Unknown");
  sec("Pending questions", (m.pendingQuestions ?? []).map((x: unknown) => txt(x).text), "None recorded");
  sec("Recent developments", (m.developments ?? []).map((x: Row) => `${d(x.at)} ${x.title} (${x.verified ? "verified" : "unverified"})`), "None recorded");
  sec("Suggested discussion points", (m.suggestedPoints ?? []).map((x: unknown) => txt(x).text), "None");
  L.push("");
  return L;
}
