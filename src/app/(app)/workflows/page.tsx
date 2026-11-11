import Link from "next/link";
import { PageHeader, Card, Badge, EmptyState } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { getSettings, listRuns, runStats } from "@/modules/workflows/service";
import { toggleWorkflowAction, runNowAction } from "@/modules/workflows/actions";
import type { WorkflowSettings } from "@/modules/workflows/rules";

export const metadata = { title: "Workflows" };
type Row = Record<string, any>;

const TONE: Record<string, "neutral" | "brand" | "ok" | "warn" | "bad" | "accent"> = {
  done: "ok", skipped: "neutral", failed: "bad", waiting_approval: "warn", running: "brand", queued: "neutral",
};
const LABEL: Record<string, string> = { done: "Done", skipped: "Skipped", failed: "Failed", waiting_approval: "Waiting for approval", running: "Running", queued: "Queued" };
const KIND: Record<string, string> = {
  signal_chain: "Signal → action", lease_chain: "Lease → renewal / relocation", reply_chain: "Reply → meeting",
  employer_chain: "Job change → re-engagement", feedback_chain: "Visit feedback → comparison", meeting_chain: "Meeting completed → follow-ups",
};
const SUBJECT: Record<string, (id: string) => [string, string]> = {
  signal: (id) => [`/signals/${id}`, "Signal"], lease: () => ["/leases", "Lease"], outreach_item: (id) => [`/outreach/${id}`, "Reply"],
  employment: () => ["/people", "Job change"], meeting_property_feedback: () => ["/meetings", "Visit feedback"], meeting_prep: (id) => [`/meetings/${id}`, "Meeting"],
};

function href(ref: Row, run: Row): string | null {
  switch (ref.type) {
    case "organisation": return `/companies/${ref.id}`;
    case "signal": return `/signals/${ref.id}`;
    case "outreach_item": return `/outreach/${ref.id}`;
    case "requirement": return `/requirements/${ref.id}`;
    case "deal_analysis": return `/toolkit/renewal/${ref.id}`;
    case "property_comparison": return `/toolkit/compare/${ref.id}`;
    case "meeting_prep": return `/meetings/${ref.id}`;
    case "draft": return "/drafts";
    case "opportunity": return `/deals/${ref.id}`;
    case "task": return "/tasks";
    case "change_proposal": return "/approvals";
    case "enrichment_job": return `/contacts/job/${ref.id}`;
    case "score_result": return run.org_id ? `/scoring/lead/${run.org_id}` : null;
    default: return null;
  }
}
const REF_LABEL: Record<string, string> = {
  organisation: "Company", outreach_item: "Draft", requirement: "Requirement", deal_analysis: "Comparison", task: "Task",
  change_proposal: "Approval", enrichment_job: "Research job", score_result: "Lead score", shortlist_version: "Shortlist",
  property_comparison: "Comparison", meeting_prep: "Meeting", draft: "Draft", opportunity: "Opportunity", signal: "Signal",
};

/** Small card other pages can link to; also shown at the top of /workflows. */
function AutomationCard({ s, stats, admin }: { s: WorkflowSettings; stats: Record<string, number>; admin: boolean }) {
  const rows = [
    { key: "signal_chain", on: s.signal_chain, title: "Signal → action", text: "New or confirmed signal: match company, find decision-makers (max once per 14 days), rescore, and — for high-priority leads with a reachable decision-maker and no outreach in 30 days — prepare one draft." },
    { key: "lease_chain", on: s.lease_chain, title: "Lease → renewal / relocation", text: "Lease within 12 months of expiry (or lock-in/notice within 6): propose a requirement, match alternatives, compare renewal vs relocation, add a task for the owner, optionally one draft." },
    { key: "reply_chain", on: s.reply_chain, title: "Reply → meeting", text: "Outreach reply asks for a meeting or shows interest: link the meeting on record (or a 'to schedule' task — no time is ever guessed), pause planned follow-ups, propose the opportunity's next action, queue preparation when a time exists." },
    { key: "employer_chain", on: s.employer_chain, title: "Job change → re-engagement", text: "A contact's move to a new employer is approved: keep history, check signals and rescore the new employer, and — if you know them, they're not do-not-contact and there's been no outreach in 30 days — prepare one congratulation draft (nothing from the old employer)." },
    { key: "feedback_chain", on: s.feedback_chain, title: "Visit feedback → comparison", text: "Site-visit feedback for a shortlisted building: mark the option visited (rejected only when the client clearly said no), re-run the saved property comparison as a new version, and add a 'Review updated comparison' task." },
    { key: "meeting_chain", on: s.meeting_chain, title: "Meeting completed → follow-ups", text: "After a meeting outcome is applied: rescore the company and show the follow-up tasks and draft the outcome created." },
  ];
  return (
    <Card title="Automation" help="Nothing is ever sent. Drafts wait for your approval; new requirements go to Approvals first.">
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium">{r.title} <Badge tone={r.on ? "ok" : "neutral"}>{r.on ? "On" : "Off"}</Badge></p>
              <p className="text-sm text-muted">{r.text}</p>
            </div>
            {admin ? (
              <ActionForm action={toggleWorkflowAction}>
                <input type="hidden" name="key" value={r.key} />
                <input type="hidden" name="on" value={r.on ? "0" : "1"} />
                <Submit variant="secondary">{r.on ? "Turn off" : "Turn on"}</Submit>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Last 30 days: {Object.entries(stats).map(([k, v]) => `${LABEL[k] ?? k} ${v}`).join(" · ") || "no runs yet"}</p>
    </Card>
  );
}

export default async function WorkflowsPage() {
  const ctx = await requirePageContext("viewer");
  const [s, runs, stats] = await Promise.all([getSettings(ctx.db, ctx.workspaceId), listRuns(ctx.db, ctx.workspaceId, { limit: 50 }), runStats(ctx.db, ctx.workspaceId)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Workflows" subtitle="Chains that run automatically every few minutes. Each step shows what happened and why."
        actions={hasRole(ctx, "editor") ? <ActionForm action={runNowAction}><Submit variant="secondary">Check now</Submit></ActionForm> : null} />
      <AutomationCard s={s} stats={stats} admin={hasRole(ctx, "admin")} />
      {!runs.length ? (
        <EmptyState title="No workflow runs yet">
          Runs start when a signal is created or confirmed (see <Link className="underline" href="/signals">Signals</Link>), when a lease with a known tenant
          enters its 12-month window (import leases in <Link className="underline" href="/imports">Imports</Link>), when an outreach reply asks for a meeting,
          when a contact's job move is approved, when site-visit feedback is saved, or when a meeting outcome is applied.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {runs.map((r: Row) => (
            <li key={r.id}>
              <Card title={<span className="flex flex-wrap items-center gap-2"><span>{KIND[r.kind] ?? r.kind}</span>{r.org ? <Link className="underline" href={`/companies/${r.org_id}`}>{r.org.display_name}</Link> : null}<Badge tone={TONE[r.status]}>{LABEL[r.status] ?? r.status}</Badge></span>}>
                <p className="text-xs text-muted">
                  {new Date(r.started_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  {" · "}
                  {(() => { const [h, l] = (SUBJECT[r.subject_type] ?? (() => ["/workflows", r.subject_type]))(r.subject_id); return <Link className="underline" href={h}>{l}</Link>; })()}
                  {r.summary ? ` · ${r.summary}` : ""}
                </p>
                <ol className="mt-2 space-y-2">
                  {r.workflow_step.map((st: Row) => (
                    <li key={st.step_key} className="rounded-lg border border-line p-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{st.seq}. {st.label}</span><Badge tone={TONE[st.status]}>{LABEL[st.status] ?? st.status}</Badge></div>
                      {st.reason ? <p className="mt-1 break-words text-muted">{st.reason}</p> : null}
                      {(st.output_refs ?? []).filter((x: Row) => href(x, r)).length ? (
                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          {(st.output_refs as Row[]).map((x, i) => { const h = href(x, r); return h ? <Link key={i} className="underline" href={h}>{REF_LABEL[x.type] ?? x.type}{x.label ? `: ${x.label}` : ""}</Link> : null; })}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
