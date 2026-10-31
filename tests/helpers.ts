import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Seeded identities (supabase/seed.sql). */
export const USERS = {
  owner: { id: "00000000-0000-4000-8000-000000000001", email: "owner@cre-os.local" },
  colleague: { id: "00000000-0000-4000-8000-000000000002", email: "colleague@cre-os.local" },
  other: { id: "00000000-0000-4000-8000-000000000003", email: "other@cre-os.local" },
} as const;
export const WS1 = "10000000-0000-4000-8000-000000000001";
export const WS2 = "10000000-0000-4000-8000-000000000002";

/** Supabase client signed in as a seeded user — RLS enforced exactly as in the app. */
export async function userClient(who: keyof typeof USERS): Promise<SupabaseClient<any, any, any>> {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, db: { schema: "mudar" } });
  const { error } = await c.auth.signInWithPassword({ email: USERS[who].email, password: "password123" });
  if (error) throw error;
  return c as SupabaseClient<any, any, any>;
}

/** Service-role client (bypasses RLS) for fixtures. */
export function adminClient(): SupabaseClient<any, any, any> {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false }, db: { schema: "mudar" } }) as SupabaseClient<any, any, any>;
}

/** Unique tag so parallel test files never collide on shared local DB. */
export const tag = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
