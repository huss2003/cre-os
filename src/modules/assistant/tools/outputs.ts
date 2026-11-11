/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
/**
 * Outputs tools (Module 12 round 2): export_deliverable (B) and show_on_map (A).
 * Suggested group: "outputs" -> ["export_deliverable", "show_on_map"] (also add show_on_map to the geo/research group).
 */
import { z } from "zod";
import type { ToolContext } from "../types";
import { ExportError, exportMessage, latestExportableMessage } from "../outputs/export";
import { buildMapBlock, type MapCandidate } from "../outputs/map";
import { HREF, db, defineTool, denied, errMsg, isUuid, missingBlock, ws, type Row } from "./shared";

const exportDeliverable = defineTool({
  id: "export_deliverable", module: "assistant", category: "B", timeoutMs: 60_000,
  description: "Turn an assistant answer (its tables, briefs, ranked lists, entity cards, sources and missing items) into a branded PowerPoint deck, Word document or PDF and return a download link. Use when the user says 'make this a deck / Word doc / PDF'. Defaults to the latest answer in this conversation that has structured content. Internal file only — nothing is sent.",
  input: z.object({
    format: z.enum(["pptx", "docx", "pdf"]).describe("pptx = deck, docx = Word, pdf = PDF"),
    messageId: z.string().optional().describe("Assistant message id; omit to use the latest structured answer in this conversation"),
  }),
  async run(i, t) {
    let messageId = i.messageId ?? null;
    if (messageId && !isUuid(messageId)) return denied(t, "export_deliverable", { entity: "assistant_message", id: messageId });
    if (!messageId) {
      if (!t.conversationId) return { ok: false, summary: "No conversation to export from", error: "no_conversation", missing: ["Ask a question first, then ask to export the answer."] };
      messageId = await latestExportableMessage(t.ctx, t.conversationId);
      if (!messageId) return { ok: false, summary: "No structured answer to export yet", error: "nothing_to_export", missing: ["No earlier answer in this conversation has a table, brief, list or card to export."] };
    }
    try {
      const r = await exportMessage(t.ctx, { messageId, format: i.format });
      const label = { pptx: "Download deck (.pptx)", docx: "Download Word doc (.docx)", pdf: "Download PDF" }[i.format];
      return {
        ok: true, summary: `Built ${r.fileName} (${r.sections} sections, sources appendix included)`,
        data: { documentId: r.documentId, fileName: r.fileName, href: r.href, sources: r.sources, missing: r.missing, note: "Internal file; not sent to anyone." },
        blocks: [{ kind: "download", label, href: r.href }],
      };
    } catch (e) {
      if (e instanceof ExportError && e.status === 404) return denied(t, "export_deliverable", { entity: "assistant_message", id: messageId });
      return { ok: false, summary: "Could not build the file", error: errMsg(e) };
    }
  },
});

const Item = z.object({
  type: z.enum(["asset", "station", "geography", "meeting", "company"]).describe("asset = building; station = infrastructure (metro/rail/etc.); company = buildings it leases"),
  id: z.string(),
});

async function candidatesFor(t: ToolContext, items: z.infer<typeof Item>[]): Promise<{ cands: MapCandidate[]; notFound: string[] }> {
  const by = (k: string) => items.filter((x) => x.type === k).map((x) => x.id).filter(isUuid);
  const cands: MapCandidate[] = []; const notFound: string[] = [];
  const pick = async (table: string, ids: string[], cols: string) => ids.length ? (((await db(t).from(table).select(cols).eq("workspace_id", ws(t)).in("id", ids)).data ?? []) as Row[]) : [];
  const assets = await pick("asset", by("asset"), "id, name, lat, lon");
  for (const a of assets) cands.push({ id: a.id, label: a.name, lat: a.lat, lon: a.lon, kind: "building", href: HREF.asset(a.id) });
  for (const s of await pick("infrastructure", by("station"), "id, name, kind, lat, lon")) cands.push({ id: s.id, label: `${s.name}${s.kind ? ` (${s.kind})` : ""}`, lat: s.lat, lon: s.lon, kind: "station" });
  for (const g of await pick("geography", by("geography"), "id, name, lat, lon")) cands.push({ id: g.id, label: g.name, lat: g.lat, lon: g.lon, kind: "other" });
  for (const m of await pick("meeting_visit", by("meeting"), "id, title, lat, lon")) cands.push({ id: m.id, label: m.title, lat: m.lat, lon: m.lon, kind: "other" });
  const orgs = await pick("organisation", by("company"), "id, display_name");
  if (orgs.length) {
    const { data: leases } = await db(t).from("lease").select("tenant_org_id, asset:asset_id(id, name, lat, lon)").eq("workspace_id", ws(t)).in("tenant_org_id", orgs.map((o) => o.id)).is("archived_at", null).limit(200);
    for (const o of orgs) {
      const mine = ((leases ?? []) as Row[]).filter((l) => l.tenant_org_id === o.id && l.asset);
      if (!mine.length) { cands.push({ id: o.id, label: `${o.display_name} (no leased building recorded)`, lat: null, lon: null, kind: "company", href: HREF.company(o.id) }); continue; }
      for (const l of mine) cands.push({ id: `${o.id}:${l.asset.id}`, label: `${o.display_name} — ${l.asset.name}`, lat: l.asset.lat, lon: l.asset.lon, kind: "company", href: HREF.company(o.id) });
    }
  }
  const found = new Set([...cands.map((c) => c.id.split(":")[0])]);
  for (const x of items) if (!found.has(x.id)) notFound.push(x.id);
  return { cands: items.flatMap((x) => cands.filter((c) => c.id === x.id || c.id.startsWith(`${x.id}:`))), notFound };
}

const showOnMap = defineTool({
  id: "show_on_map", module: "geo", category: "A",
  description: "Show buildings, stations, localities, meetings or a company's leased buildings on a map, using coordinates stored on the records only (never guessed). Optionally draw straight-line radius rings (km) around one point — say 'straight-line', not travel time. Records without coordinates are listed as missing.",
  input: z.object({
    items: z.array(Item).min(1).max(50),
    title: z.string().max(120).optional(),
    centerId: z.string().optional().describe("Id of an item (asset/station/geography/meeting) to draw rings around"),
    radiiKm: z.array(z.number().positive().max(100)).max(5).optional().describe("Straight-line ring radii in km, e.g. [1, 3, 5]"),
  }),
  async run(i, t) {
    const bad = i.items.filter((x) => !isUuid(x.id));
    if (bad.length === i.items.length) return denied(t, "show_on_map", { entity: bad[0].type, id: bad[0].id });
    const { cands, notFound } = await candidatesFor(t, i.items);
    if (notFound.length === i.items.length) return denied(t, "show_on_map", { entity: i.items[0].type, id: i.items[0].id });
    const { block, missing, placed } = buildMapBlock(cands, { title: i.title, centerId: i.centerId ?? null, radiiKm: i.radiiKm });
    const allMissing = [...missing, ...(notFound.length ? [`${notFound.length} record(s) not found or no access`] : [])];
    return {
      ok: true, summary: placed ? `Mapped ${placed} place(s)${allMissing.length ? `; ${allMissing.length} not shown` : ""}` : "Nothing to map — no stored coordinates",
      data: { placed, notShown: allMissing, method: "stored coordinates; rings are straight-line km" },
      missing: allMissing, coverage: { checked: cands.length, withData: placed, note: missing.length ? "Some records have no coordinates" : undefined },
      blocks: [...(block ? [block] : []), ...missingBlock(allMissing)],
    };
  },
});

export const outputsTools = [exportDeliverable, showOnMap];
export const OUTPUTS_GROUP = { outputs: ["export_deliverable", "show_on_map"] } as const;
