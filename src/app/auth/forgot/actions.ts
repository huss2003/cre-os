"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

async function appUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function requestReset(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  if (email) {
    const db = await createUserClient();
    const redirectTo = `${await appUrl()}/auth/callback?next=/auth/update-password`;
    // Result intentionally ignored: same response whether or not the account exists (no enumeration).
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) console.warn("resetPasswordForEmail:", error.message);
  }
  redirect("/auth/forgot?sent=1");
}
