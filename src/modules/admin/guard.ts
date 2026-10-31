import "server-only";
import { redirect } from "next/navigation";
import { getContext, hasRole, HttpError, requireContext, requirePageContext, type AppContext, type Role } from "@/lib/auth/context";
import type { Db } from "@/lib/supabase/server";
import { mfaDecision, ownerMfaEnforced, type Aal, type MfaDecision } from "./mfa";

async function aal(db: Db): Promise<{ currentLevel: Aal; nextLevel: Aal }> {
  try {
    const { data } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    return { currentLevel: (data?.currentLevel ?? null) as Aal, nextLevel: (data?.nextLevel ?? null) as Aal };
  } catch {
    return { currentLevel: null, nextLevel: null };
  }
}

export async function mfaStatus(ctx: AppContext, privileged = ctx.role === "owner"): Promise<MfaDecision> {
  const levels = await aal(ctx.db);
  return mfaDecision({ privileged, ...levels, enforce: ownerMfaEnforced() });
}

/** Admin pages (/settings/**, /admin/**): role check + owner AAL2 step-up / enrolment. */
export async function requireAdminPage(minRole: Role = "admin", nextPath = "/settings"): Promise<AppContext & { mfa: MfaDecision }> {
  const ctx = await requirePageContext(minRole);
  const mfa = await mfaStatus(ctx);
  if (mfa === "verify" || mfa === "enrol") redirect(`/settings/security?${mfa}=1&next=${encodeURIComponent(nextPath)}`);
  return { ...ctx, mfa };
}

/** Admin API routes: same policy, as HTTP errors. */
export async function requireAdminApi(minRole: Role = "admin"): Promise<AppContext> {
  const ctx = await requireContext(minRole);
  const mfa = await mfaStatus(ctx);
  if (mfa === "verify") throw new HttpError(403, "mfa_required: complete TOTP verification (AAL2) first");
  if (mfa === "enrol") throw new HttpError(403, "mfa_enrolment_required: owners must enrol TOTP at /settings/security");
  return ctx;
}

/** Platform pages (/platform/**): platform_admin only; AAL2 if a factor is enrolled. Membership not required. */
export async function requirePlatformPage(nextPath = "/platform"): Promise<AppContext & { mfa: MfaDecision }> {
  const ctx = await getContext();
  if (!ctx) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (!ctx.isPlatformAdmin) redirect("/forbidden");
  const mfa = await mfaStatus(ctx, true);
  if (mfa === "verify" || mfa === "enrol") redirect(`/platform/security?${mfa}=1&next=${encodeURIComponent(nextPath)}`);
  return { ...ctx, mfa };
}

/** Platform server actions: platform_admin + AAL2 policy, as HTTP errors. Membership not required. */
export async function requirePlatformApi(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) throw new HttpError(401, "unauthenticated");
  if (!ctx.isPlatformAdmin) throw new HttpError(403, "platform admin only");
  const mfa = await mfaStatus(ctx, true);
  if (mfa === "verify") throw new HttpError(403, "mfa_required: complete TOTP verification (AAL2) first");
  if (mfa === "enrol") throw new HttpError(403, "mfa_enrolment_required: enrol TOTP at /platform/security");
  return ctx;
}

export { hasRole };
