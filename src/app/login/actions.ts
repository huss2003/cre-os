"use server";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export async function signIn(form: FormData) {
  const db = await createUserClient();
  const next = String(form.get("next") || "/today");
  const { error } = await db.auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`);
  redirect(next.startsWith("/") ? next : "/today");
}
