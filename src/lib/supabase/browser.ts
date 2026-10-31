"use client";
import { createBrowserClient } from "@supabase/ssr";
import { DB_SCHEMA } from "./schema";

export function createBrowserSupabase() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { db: { schema: DB_SCHEMA } });
}
