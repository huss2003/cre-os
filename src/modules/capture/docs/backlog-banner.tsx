import { StaleBanner } from "@/components/ui";
import type { Db } from "@/lib/supabase/server";
import { jobBacklog } from "./review";
import { backlogMessage } from "./backlog";

/** Rule S10: say so when queued background work is overdue (e.g. nothing is running the scheduler). Read-only. */
export async function JobBacklogBanner({ db, ws }: { db: Db; ws: string }) {
  const msg = backlogMessage(await jobBacklog(db, ws).catch(() => null));
  return msg ? <div role="status"><StaleBanner>{msg}</StaleBanner></div> : null;
}
