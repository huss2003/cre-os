/** Pure consent / verification helpers for network intelligence. */

export interface ConsentLite { given_on: string; expires_on: string | null; revoked_at: string | null }

/** Active = given on or before today, not revoked, not expired. */
export function consentIsActive(c: ConsentLite, today: string): boolean {
  if (!c || c.revoked_at) return false;
  if (!c.given_on || String(c.given_on).slice(0, 10) > today) return false;
  return !c.expires_on || String(c.expires_on).slice(0, 10) >= today;
}

/**
 * A job move stays "unverified" until a human confirms it: either the claim was marked confirmed (verification task done)
 * or the employment proposals were applied through Approvals.
 */
export function jobMoveVerified(claimStatus: string, proposalStates: string[]): boolean {
  if (claimStatus === "currently_confirmed") return true;
  return proposalStates.length > 0 && proposalStates.every((s) => s === "applied");
}

/** Deterministic dedupe key of the verification task for a candidate move (same person + new employer => one task). */
export const verifyTaskKey = (personId: string, toOrgId: string) => `network.verify_job_move:${personId}:${toOrgId}`;
