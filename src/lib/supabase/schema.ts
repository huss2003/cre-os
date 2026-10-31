/**
 * CRE OS lives in its own Postgres schemas so it can share a Supabase project with other apps:
 *   mudar      — all CRE OS tables, views, enums and RLS policies
 *   mudar_app  — CRE OS SQL functions (RLS helpers, job queue, change/approval RPCs)
 * Both must be listed in Supabase → Project Settings → API → Exposed schemas.
 */
export const DB_SCHEMA = "mudar" as const;
export const APP_SCHEMA = "mudar_app" as const;
export const STORAGE_BUCKET = "mudar-workspace-files" as const;
