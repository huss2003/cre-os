import "server-only";
import { HttpError } from "@/lib/auth/context";
import { AdminError } from "./errors";

/** Map module errors to HttpError so the shared route() wrapper returns the right status. */
export async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AdminError) throw new HttpError(e.status, e.message, e.details);
    throw e;
  }
}

/** For server actions: turn any error into a user-facing message (zod issues flattened). */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown[] }).issues)) {
    return (e as { issues: { path: (string | number)[]; message: string }[] }).issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  }
  const raw = e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return friendlyDbError(raw);
}

/** Database errors in words a non-technical user can act on. Unknown messages pass through unchanged. */
export function friendlyDbError(raw: string): string {
  const uq = raw.match(/duplicate key value violates unique constraint "([^"]+)"/);
  if (uq) {
    const c = uq[1];
    if (/cin/.test(c)) return "Another company already has this CIN. Open that company instead of creating a duplicate.";
    if (/gstin/.test(c)) return "Another company already has this GSTIN. Open that company instead of creating a duplicate.";
    if (/domain/.test(c)) return "Another company already uses this website domain.";
    if (/reg/.test(c)) return "A lease with this registration number already exists.";
    return "This record already exists (a value that must be unique is already used). Search for it instead of adding it again.";
  }
  if (/cross-workspace reference/.test(raw)) return "That linked record belongs to another workspace and cannot be used here.";
  if (/violates foreign key constraint|foreign key .* not found/.test(raw)) return "A linked record was not found (it may have been archived or removed). Pick it again.";
  const ck = raw.match(/violates check constraint "([^"]+)"/);
  if (ck) {
    const c = ck[1];
    if (/end|until|expiry|to_|dates/.test(c)) return "The end date must be on or after the start date.";
    if (/area|sf/.test(c)) return "Area must be a positive number. Leave it blank if unknown.";
    if (/lat|lon/.test(c)) return "Latitude must be between -90 and 90 and longitude between -180 and 180.";
    if (/self|parent|from_org/.test(c)) return "A record cannot be linked to itself.";
    if (/share/.test(c)) return "Shares must be between 0 and 1, and together cannot exceed 1.";
    return "One of the values is not allowed. Check numbers are positive and dates are in order.";
  }
  if (/invalid input syntax for type (numeric|integer)/.test(raw)) return "A number field contains text. Enter digits only, or leave it blank.";
  if (/invalid input syntax for type date|date\/time field value out of range/.test(raw)) return "A date is not valid. Use the date picker.";
  if (/row-level security|permission denied/.test(raw)) return "Your role cannot make this change. Ask an owner or admin.";
  return raw;
}
