/**
 * Owner MFA policy (spec §14 "Use MFA"; Part III "Owner MFA"). Pure decision logic — the Supabase calls live in guard.ts.
 *  - Owners (and platform admins on /platform) with a verified TOTP factor must be at AAL2 on admin pages.
 *  - Owners without a factor are sent to enrol when enforcement is on (production by default), otherwise warned.
 */
export type Aal = "aal1" | "aal2" | null | undefined;
export type MfaDecision = "ok" | "verify" | "enrol" | "warn";

export function ownerMfaEnforced(env: Record<string, string | undefined> = process.env): boolean {
  if (env.OWNER_MFA_ENFORCE === "true") return true;
  if (env.OWNER_MFA_ENFORCE === "false") return false;
  return env.NODE_ENV === "production";
}

export function mfaDecision(input: { privileged: boolean; currentLevel: Aal; nextLevel: Aal; enforce: boolean }): MfaDecision {
  if (!input.privileged) return "ok";
  if (input.currentLevel === "aal2") return "ok";
  if (input.nextLevel === "aal2") return "verify";      // factor enrolled but this session has not stepped up
  return input.enforce ? "enrol" : "warn";
}
