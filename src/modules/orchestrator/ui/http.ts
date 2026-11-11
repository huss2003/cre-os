import "server-only";
import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { AutomationError, type Actor } from "./service";

/** Shared helpers for /api/v1/orchestrator/** routes. */
export async function apiActor(): Promise<Actor> {
  const ctx = await requireContext("viewer");
  return { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: ctx.timezone };
}
export async function asApi<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { if (e instanceof AutomationError) throw new HttpError(e.status, e.message); throw e; }
}
export const workflowBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }), z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("schedule"), everyMinutes: z.number().int().nullable(), nextRunAt: z.string().datetime().nullable().optional() }),
  z.object({ action: z.literal("priority"), priority: z.number().int().min(0).max(100) }),
  z.object({ action: z.literal("start"), input: z.record(z.string(), z.unknown()).optional() }),
]);
export const runBody = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "cancel", "retry", "continue"]) }),
  z.object({ action: z.literal("priority"), priority: z.number().int().min(0).max(100) }),
]);
export const markBody = z.object({ action: z.enum(["refresh", "dismiss"]) });
export const startBody = z.object({ request: z.string().min(3).max(1000).optional(), workflowKey: z.string().max(120).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
  .refine((b) => b.request || b.workflowKey, "request or workflowKey required");
