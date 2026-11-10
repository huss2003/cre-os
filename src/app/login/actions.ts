"use server";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/util/safe-redirect";

export async function signIn(form: FormData) {
  const db = await createUserClient();
  const next = safeNext(String(form.get("next") || ""), "/");
  const { error } = await db.auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`);
  redirect(next);
}
