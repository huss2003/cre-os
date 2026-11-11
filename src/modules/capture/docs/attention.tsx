import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import type { AttentionQueues } from "./review";
import { requestInfoAction, retryJobAction } from "./actions";
import { TYPE_LABEL, type DocType } from "./detect";

/** Review §12.4 attention queues — only non-empty queues are shown; counts in the summary row. */
export function AttentionPanel({ q, editor }: { q: AttentionQueues; editor: boolean }) {
  const counts: [string, number, string][] = [
    ["Files needing input", q.documents.length, "#q-files"],
    ["Needs more info", q.needsInfo.length, "#q-info"],
    ["Unverified contact details", q.unverified.length, "#q-unverified"],
    ["Outreach drafts", q.drafts, "/approvals?tab=drafts"],
    ["Company matches", q.companyMatches.length, "#q-matches"],
    ["Duplicate contacts", q.duplicateContacts.length, "#q-dupes"],
    ...(q.failedJobs ? [["Failed processing", q.failedJobs.length, "#q-jobs"] as [string, number, string]] : []),
  ];
  const open = counts.filter(([, n]) => n > 0);
  if (!open.length) return null;
  const byBatch = (rows: typeof q.companyMatches): [string, number][] => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r.batch_id), (m.get(String(r.batch_id)) ?? 0) + 1);
    return [...m.entries()];
  };
  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-2" aria-label="Needs attention">
        {open.map(([label, n, href]) => <Link key={label} href={href} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm">{label} <Badge tone="warn">{n}</Badge></Link>)}
      </nav>

      {q.documents.length ? (
        <Card title={`Files needing input (${q.documents.length})`}><ul id="q-files" className="divide-y divide-line">{q.documents.map((d) => (
          <li key={d.id} className="py-2 text-sm"><Link className="font-medium text-brand" href={`/capture/documents/${d.id}`}>{d.file_name}</Link>
            <span className="ml-2"><Badge tone={d.status === "failed" ? "bad" : "warn"}>{d.status === "failed" ? "failed" : TYPE_LABEL[d.detected_type as DocType] ?? d.detected_type}</Badge></span>
            <p className="text-xs text-ink-soft">{d.error}</p></li>
        ))}</ul></Card>
      ) : null}

      {q.needsInfo.length ? (
        <Card title={`Needs more info (${q.needsInfo.length})`} help="Proposals someone asked questions about. Edit the proposal once you have the answer; a task tracks the follow-up."><ul id="q-info" className="divide-y divide-line">{q.needsInfo.map((p) => (
          <li key={p.id} className="py-2 text-sm"><Badge tone="warn">clarify</Badge> {p.operation} {p.target_type}<p className="line-clamp-2 text-xs text-ink-soft">{p.reason}</p></li>
        ))}</ul></Card>
      ) : null}

      {q.unverified.length ? (
        <Card title={`Unverified contact details (${q.unverified.length})`} help="Emails and phones not yet checked. Confirm them on the person's page before outreach."><ul id="q-unverified" className="divide-y divide-line">{q.unverified.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0 truncate">{c.person?.full_name ?? "—"} · {c.method_type} {c.value}</span>
            <span className="flex items-center gap-2"><Badge>{c.verify_status ?? "unknown"}</Badge><Link className="text-brand underline" href={`/people/${c.person_id}`}>Open</Link></span>
          </li>
        ))}</ul></Card>
      ) : null}

      {q.companyMatches.length || q.duplicateContacts.length ? (
        <Card title="Possible matches and duplicates" help="Never merged silently. Open the import to link, keep separate or propose a merge.">
          <ul className="divide-y divide-line text-sm">
            {byBatch(q.companyMatches).map(([b, n]) => <li id="q-matches" key={`o${b}`} className="py-2">{n} uncertain company match{n > 1 ? "es" : ""} — <Link className="text-brand underline" href={`/imports/${b}`}>review</Link></li>)}
            {byBatch(q.duplicateContacts).map(([b, n]) => <li id="q-dupes" key={`p${b}`} className="py-2">{n} possible duplicate contact{n > 1 ? "s" : ""} — <Link className="text-brand underline" href={`/imports/${b}`}>review</Link></li>)}
          </ul>
        </Card>
      ) : null}

      {q.failedJobs?.length ? (
        <Card title={`Failed processing (${q.failedJobs.length})`} help="Background work that stopped. Retry once the cause (e.g. a missing key or file) is fixed."><ul id="q-jobs" className="divide-y divide-line">{q.failedJobs.map((j) => (
          <li key={j.id} className="space-y-1 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span><Badge tone="bad">{j.state}</Badge> {j.job_type} · {j.attempts}/{j.max_attempts} tries · {fmt(j.updated_at)}</span>
              {editor ? <ActionForm action={retryJobAction}><input type="hidden" name="job_id" value={j.id} /><Submit variant="secondary">Retry</Submit></ActionForm> : null}</div>
            {j.last_error ? <p className="line-clamp-2 text-xs text-ink-soft">{j.last_error}</p> : null}
          </li>
        ))}</ul></Card>
      ) : null}
    </div>
  );
}

/** "Request more info" on a proposal: marks it 'clarify' and adds a linked internal task. */
export function RequestInfo({ proposalId }: { proposalId: string }) {
  return (
    <details className="-mt-2 rounded-b-xl border border-t-0 border-line bg-surface px-3 py-2 text-sm">
      <summary className="cursor-pointer text-ink-soft">Request more info</summary>
      <ActionForm action={requestInfoAction} className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input type="hidden" name="proposal_id" value={proposalId} />
        <input name="note" required placeholder="What's missing? e.g. need the signed LOI page" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2" />
        <Submit variant="secondary">Ask</Submit>
      </ActionForm>
    </details>
  );
}
