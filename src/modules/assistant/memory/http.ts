import { HttpError } from "@/lib/auth/context";
import { MemoryError } from "./service";
import { CommandError } from "../commands/service";

/** Map domain errors to 4xx for API routes. */
export async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof MemoryError || e instanceof CommandError) throw new HttpError(/not found/i.test(e.message) ? 404 : 422, e.message);
    throw e;
  }
}
