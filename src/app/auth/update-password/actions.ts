"use server";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

const back = (m: string) => redirect(`/auth/update-password?error=${encodeURIComponent(m)}`);

export async function updatePassword(form: FormData) {
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (password.length < 8) back("Use at least 8 characters.");
  if (password !== confirm) back("The two passwords don't match.");
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect("/auth/update-password");
  const { error } = await db.auth.updateUser({ password });
  if (error) back(/different from the old/i.test(error.message) ? "Choose a password different from your old one." : error.message);
  redirect(`/?notice=${encodeURIComponent("Password updated. You're signed in.")}`);
}
