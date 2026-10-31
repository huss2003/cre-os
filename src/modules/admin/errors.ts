/** Module errors (no Next.js imports so services stay unit-testable). Routes map them to HTTP codes. */
export class AdminError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = "record") => new AdminError(404, `${what} not found or not visible to you`);
export const forbidden = (why = "forbidden") => new AdminError(403, why);
export const conflict = (why = "record changed since you loaded it; reload and retry") => new AdminError(409, why);
export const badRequest = (why: string, details?: unknown) => new AdminError(400, why, details);
