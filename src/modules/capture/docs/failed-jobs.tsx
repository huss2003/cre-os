import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { errorSummary, jobLabel, jobRecordLink } from "./review";
import { retryJobAction } from "./actions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Review → Failed jobs. Admins get the list (plain-words job type, error summary, attempts, when, Retry, related record).
 * Everyone else only sees how many failed and who can fix it (job details are admin-only by RLS).
 */
export function FailedJobsQueue({ jobs, count, admin }: { jobs: Row[] | null; count: number; admin: boolean }) {
  if (!admin) {
    return (
      <Card>
        <EmptyState title={count ? `${count} background job${count === 1 ? "" : "s"} failed` : "No failed background jobs"}>
          {count
            ? "Something running in the background (an import, a file, a scheduled check) stopped with an error. Only a workspace admin can see the details and retry it — ask your admin to open Review → Failed jobs."
            : "Imports, file processing and scheduled checks are all running normally."}
        </EmptyState>
      </Card>
    );
  }
  if (!jobs?.length) {
    return <Card><EmptyState title="No failed background jobs">When an import, file, or scheduled check stops with an error it is listed here with a Retry button. Nothing has failed.</EmptyState></Card>;
  }
  return (
    <Card title={`Failed jobs (${jobs.length})`} help="Background work that stopped after its retries. Fix the cause (e.g. a missing key or a bad file), then press Retry.">
      <ul className="divide-y divide-line" data-testid="failed-jobs">
        {jobs.map((j) => {
          const link = jobRecordLink(j);
          return (
            <li key={j.id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{jobLabel(String(j.job_type))}</p>
                  <p className="text-xs text-ink-soft">
                    <Badge tone="bad">{j.state === "dead" ? "gave up" : "failed"}</Badge>{" "}
                    {j.attempts}/{j.max_attempts} tries · {fmt(j.updated_at)} · <span className="font-mono">{j.job_type}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {link ? <Link className="text-brand underline" href={link.href}>{link.label}</Link> : null}
                  <ActionForm action={retryJobAction}><input type="hidden" name="job_id" value={j.id} /><Submit variant="secondary">Retry</Submit></ActionForm>
                </div>
              </div>
              <p className="break-words text-xs text-ink-soft">{errorSummary(j.last_error)}</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
