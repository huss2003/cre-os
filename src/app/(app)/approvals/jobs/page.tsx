import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { failedJobCount, listFailedJobs } from "@/modules/capture/docs/review";
import { FailedJobsQueue } from "@/modules/capture/docs/failed-jobs";
import { JobBacklogBanner } from "@/modules/capture/docs/backlog-banner";
import { StewardNav } from "@/modules/changes/ui/steward-ui";

export const metadata = { title: "Failed jobs" };

async function Body() {
  const ctx = await requirePageContext();
  const admin = hasRole(ctx, "admin");
  const [jobs, count] = await Promise.all([admin ? listFailedJobs(ctx.db, ctx.workspaceId) : Promise.resolve(null), failedJobCount(ctx.db, ctx.workspaceId)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Failed jobs" subtitle="Background work (imports, file processing, scheduled checks) that stopped with an error." />
      <StewardNav current="jobs" />
      <JobBacklogBanner db={ctx.db} ws={ctx.workspaceId} />
      <FailedJobsQueue jobs={jobs} count={count} admin={admin} />
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton variant="list" />}><Body /></Suspense>;
}
