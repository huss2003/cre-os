import "server-only";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireContext, type AppContext, type Role } from "@/lib/auth/context";

/** Friendly message for form errors (validation, RLS, conflicts, domain errors). Never includes stack traces. */
export function errorMessage(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  const code = (e as { code?: string })?.code;
  if (code === "42501") return "You don't have permission to do that in this workspace.";
  if (code === "23505") return "That already exists.";
  if (e instanceof Error) return e.message.slice(0, 300);
  return "Something went wrong.";
}

/**
 * Run a form action: auth + role check, then redirect back with ?notice= or ?error=. Redirect happens outside the try so
 * Next's redirect signal is never swallowed.
 */
export async function formAction(path: string, minRole: Role, fn: (ctx: AppContext) => Promise<string | { notice: string; to?: string }>) {
  let to = path;
  let q: string;
  try {
    const ctx = await requireContext(minRole);
    const r = await fn(ctx);
    const notice = typeof r === "string" ? r : r.notice;
    if (typeof r !== "string" && r.to) to = r.to;
    q = `notice=${encodeURIComponent(notice)}`;
  } catch (e) {
    q = `error=${encodeURIComponent(errorMessage(e))}`;
  }
  revalidatePath(path);
  redirect(`${to}${to.includes("?") ? "&" : "?"}${q}`);
}

export const str = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };
export const intOrNull = (f: FormData, k: string) => { const v = str(f, k); return v === null || Number.isNaN(Number(v)) ? null : Number(v); };
