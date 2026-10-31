import type { NextRequest } from "next/server";
import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { contentCalendar } from "@/modules/intelligence/content/service";
import { addDays, isoDate } from "@/modules/intelligence/common";

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: today + 6 weeks). Planned posts + unscheduled open posts. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const d = (k: string) => { const v = req.nextUrl.searchParams.get(k); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
  const from = d("from") ?? isoDate(new Date())!;
  const to = d("to") ?? addDays(from, 42);
  return { from, to, ...(await guard(contentCalendar(ctx.db, ctx.workspaceId, from, to))) };
});
