import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DB_SCHEMA } from "./schema";

export type Db = SupabaseClient<any, any, any>;

/** Request-scoped client acting AS THE SIGNED-IN USER. RLS is enforced. Use for all user-initiated reads/writes. */
export async function createUserClient(): Promise<Db> {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      db: { schema: DB_SCHEMA },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            /* called from a Server Component: proxy refreshes the session */
          }
        },
      },
    },
  ) as Db;
}
