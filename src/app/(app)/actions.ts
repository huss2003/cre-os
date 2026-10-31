"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WS_COOKIE, getContext } from "@/lib/auth/context";

export async function switchWorkspace(form: FormData) {
  const id = String(form.get("workspace_id") ?? "");
  const ctx = await getContext();
  if (!ctx || !ctx.workspaces.some((w) => w.id === id)) redirect("/forbidden");
  (await cookies()).set(WS_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/today");
}
