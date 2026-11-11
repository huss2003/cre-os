import { z } from "zod";
import { accountFilterSchema, filterChips, type AccountFilter } from "@/modules/search/filter";
import { findAccounts, nlToFilter } from "@/modules/search/finder";
import { HREF, db, defineTool, ref, ws } from "./shared";

/**
 * Search module tools (spec §2.9). find_accounts runs the structured account finder: the typed filter is validated
 * by zod and passed as a parameter to a SECURITY INVOKER SQL function — no model-written SQL (S7).
 */
const findAccountsTool = defineTool({
  id: "find_accounts", module: "database", category: "A",
  description: "Find companies (accounts) by occupancy and relationship facts: occupied area range + basis, micro-market/city, building grade, lease events (expiry / lock-in end / notice / break) in a window, sector, 'contact I already know', signals since a date, lead priority band, requirement status, open deal. Pass either `text` (the user's request in plain words, e.g. 'companies occupying 15,000–40,000 SF in Kharadi with a lease event next year and a contact I already know') or a typed `filter`. Returns each match with the lease, contact and signal that made it match, plus coverage (how many companies could not be evaluated because lease area or dates are unknown).",
  input: z.object({
    text: z.string().max(500).optional().describe("Plain-language account search; parsed deterministically into a filter"),
    filter: accountFilterSchema.optional().describe("Typed filter; overrides fields parsed from text"),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(i, t) {
    let filter: AccountFilter = {};
    let understood: string[] = [];
    if (i.text?.trim()) {
      const p = await nlToFilter(db(t), ws(t), i.text, { useModel: false });
      filter = p.filter; understood = p.understood;
    }
    if (i.filter) filter = { ...filter, ...i.filter };
    if (!Object.keys(filter).length) return { ok: false, summary: "No search criteria understood", error: "Give at least one criterion (area, place, lease event, contact, signal, priority…).", missing: ["criteria"] };
    const r = await findAccounts(db(t), ws(t), filter, { limit: i.limit ?? 25 });
    const c = r.coverage;
    const notes: string[] = [];
    if (c.areaUnknown) notes.push(`${c.areaUnknown} compan${c.areaUnknown === 1 ? "y" : "ies"} had no lease area on the requested basis, so could not be checked`);
    if (c.eventsUnknown) notes.push(`${c.eventsUnknown} had no lease dates, so lease events could not be checked`);
    if (c.unresolvedPlaces.length) notes.push(`place not in the geography list: ${c.unresolvedPlaces.join(", ")} (matched on company location text only)`);
    const rows = r.results;
    return {
      ok: true,
      summary: `${rows.length} account${rows.length === 1 ? "" : "s"} match (${filterChips(r.filter).map((x) => x.label).join("; ")})`,
      data: {
        filter: r.filter, understood, window: r.window, coverage: c,
        items: rows.map((h) => ({ ...h, href: HREF.company(h.orgId) })),
      },
      entities: rows.map((h) => ref("company", h.orgId, h.name, HREF.company(h.orgId))),
      blocks: rows.length ? [{
        kind: "table", title: "Matching accounts",
        columns: ["Company", "Area (SF)", "Lease event", "Known contact", "Signal"],
        rows: rows.map((h) => [
          h.name,
          h.areaSf === null ? null : `${Math.round(h.areaSf).toLocaleString("en-IN")} ${h.areaBasis ?? ""}`.trim(),
          h.events?.[0] ? `${h.events[0].type} ${h.events[0].date}` : null,
          h.contacts?.[0] ? `${h.contacts[0].name} (${h.contacts[0].basis})` : null,
          h.signals?.[0]?.title ?? null,
        ]),
      }] : [],
      missing: notes,
      coverage: { checked: c.candidates, withData: Math.max(0, c.candidates - (c.areaUnknown ?? 0) - (c.eventsUnknown ?? 0)), note: notes.join("; ") || undefined },
    };
  },
});

export const search2Tools = [findAccountsTool];
