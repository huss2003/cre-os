import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Db } from "./server";

/**
 * Service-role client. BYPASSES RLS. Only for scheduled jobs, webhooks and platform admin.
 * Every query made with it MUST filter by workspace_id explicitly (see AGENTS.md rule S2).
 */
let cached: Db | null = null;
export function createAdminClient(): Db {
  if (cached) return cached;
  cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as Db;
  return cached;
}

/** Same, for the `app` schema RPCs (job queue etc.). */
export function adminApp() {
  return createAdminClient().schema("app");
}
