import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createUserClient, type Db } from "@/lib/supabase/server";

export type Role = "owner" | "admin" | "editor" | "viewer";
export type Classification = "public" | "permitted_personal" | "corporate_confidential" | "licensed_restricted";

export interface AppContext {
  db: Db;                      // user-scoped client (RLS enforced)
  userId: string;
  email: string | null;
  workspaceId: string;
  workspaceName: string;
  timezone: string;
  role: Role;
  allowedClassifications: Classification[];
  isPlatformAdmin: boolean;
  workspaces: { id: string; name: string; role: Role }[];
}

const ORDER: Role[] = ["viewer", "editor", "admin", "owner"];
export const WS_COOKIE = "cre_ws";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Load the signed-in user's context for the selected workspace. Returns null when signed out / no membership. */
export async function getContext(): Promise<AppContext | null> {
  const db = await createUserClient();
  const { data: u } = await db.auth.getUser();
  if (!u.user) return null;
  const { data: rows } = await db.from("my_workspaces").select("*").order("name");
  const list = (rows ?? []) as { id: string; name: string; role: Role; timezone: string; allowed_classifications: Classification[] }[];
  const { data: pa } = await db.from("platform_admin").select("user_id").eq("user_id", u.user.id).maybeSingle();
  if (list.length === 0) {
    return {
      db, userId: u.user.id, email: u.user.email ?? null, workspaceId: "", workspaceName: "", timezone: "Asia/Kolkata",
      role: "viewer", allowedClassifications: [], isPlatformAdmin: !!pa, workspaces: [],
    };
  }
  const chosen = (await cookies()).get(WS_COOKIE)?.value;
  const ws = list.find((w) => w.id === chosen) ?? list[0];
  return {
    db,
    userId: u.user.id,
    email: u.user.email ?? null,
    workspaceId: ws.id,
    workspaceName: ws.name,
    timezone: ws.timezone,
    role: ws.role,
    allowedClassifications: ws.allowed_classifications,
    isPlatformAdmin: !!pa,
    workspaces: list.map((w) => ({ id: w.id, name: w.name, role: w.role })),
  };
}

/** For pages: redirect to /login when signed out. */
export async function requirePageContext(minRole: Role = "viewer"): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  if (!ctx.workspaceId) redirect("/no-workspace");
  if (!hasRole(ctx, minRole)) redirect("/forbidden");
  return ctx;
}

/** For route handlers / server actions: throw HttpError instead of redirecting. */
export async function requireContext(minRole: Role = "viewer"): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) throw new HttpError(401, "unauthenticated");
  if (!ctx.workspaceId) throw new HttpError(403, "no workspace membership");
  if (!hasRole(ctx, minRole)) throw new HttpError(403, `requires ${minRole}`);
  return ctx;
}

export function hasRole(ctx: Pick<AppContext, "role">, min: Role) {
  return ORDER.indexOf(ctx.role) >= ORDER.indexOf(min);
}
