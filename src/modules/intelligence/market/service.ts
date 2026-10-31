import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { type AiCall, MARKET_DISCLAIMER } from "../common";
import { gateObservations, annualTrend, comparables, factsFromTrend, metricKind, supplyAbsorptionRatio, deriveVacancy, type Observation, type TxLite, type CompsQuery, type TrendPoint } from "./series";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function loadObservations(db: Db, workspaceId: string): Promise<{ observations: Observation[]; geoNames: Map<string, string> }> {
  const { data, error } = await db.from("market_observation")
    .select("id, metric, geography_id, geography_raw, period_start, period_end, period_type, unit, value, definition, release_date, source_object_id, source_version")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("period_start").limit(5000);
  if (error) throw error;
  const observations = ((data ?? []) as Row[]).map((o) => ({ ...(o as unknown as Observation), value: num(o.value) }));
  const geoIds = [...new Set(observations.map((o) => o.geography_id).filter((x): x is string => !!x))];
  const geoNames = new Map<string, string>();
  if (geoIds.length) {
    const { data: g } = await db.from("geography").select("id, name").eq("workspace_id", workspaceId).in("id", geoIds);
    for (const r of (g ?? []) as Row[]) geoNames.set(String(r.id), String(r.name));
  }
  return { observations, geoNames };
}

export interface SeriesView { metric: string; kind: string; geography: string; geographyLabel: string; points: TrendPoint[] }

/** Gated annual trends per metric × geography, plus excluded observations with reasons (shown, never hidden). */
export async function marketOverview(db: Db, workspaceId: string) {
  const { observations, geoNames } = await loadObservations(db, workspaceId);
  const gate = gateObservations(observations);
  const keys = new Map<string, { metric: string; geo: string }>();
  for (const o of gate.accepted) { const geo = o.geography_id ?? o.geography_raw ?? "Unspecified"; keys.set(`${o.metric}|${geo}`, { metric: o.metric, geo }); }
  const series: SeriesView[] = [...keys.values()].map(({ metric, geo }) => ({
    metric, kind: metricKind(metric), geography: geo, geographyLabel: geoNames.get(geo) ?? geo,
    points: annualTrend(gate.accepted.map((o) => ({ ...o, geography_id: o.geography_id ?? null, geography_raw: o.geography_id ? null : o.geography_raw ?? "Unspecified" })), metric, geo),
  })).sort((a, b) => a.metric.localeCompare(b.metric) || a.geographyLabel.localeCompare(b.geographyLabel));
  const ratios = series.filter((s) => /supply/i.test(s.metric)).map((s) => {
    const abs = series.find((x) => /absorption/i.test(x.metric) && x.geography === s.geography);
    return abs ? { geography: s.geographyLabel, rows: supplyAbsorptionRatio(s.points, abs.points) } : null;
  }).filter(Boolean) as { geography: string; rows: ReturnType<typeof supplyAbsorptionRatio> }[];
  const hasVacancy = gate.accepted.some((o) => /vacancy|available_inventory/i.test(o.metric));
  const vacancy = hasVacancy ? null : deriveVacancy({});
  return { series, excluded: gate.excluded, ratios, vacancyNote: vacancy?.reason ?? null, disclaimer: MARKET_DISCLAIMER, total: observations.length };
}

export async function marketComparables(db: Db, workspaceId: string, q: CompsQuery) {
  const { data, error } = await db.from("market_transaction")
    .select("id, asset_id, tenant_org_id, tenant_name_raw, period_start, deal_type, area_sf, rent_min, rent_max, rent_basis, source_object_id")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("period_start", { ascending: false, nullsFirst: false }).limit(2000);
  if (error) throw error;
  const txs = (data ?? []) as Row[];
  const assetIds = [...new Set(txs.map((t) => t.asset_id).filter(Boolean) as string[])];
  const assets = assetIds.length ? (((await db.from("asset").select("id, name, locality_id").eq("workspace_id", workspaceId).in("id", assetIds)).data ?? []) as Row[]) : [];
  const locIds = [...new Set(assets.map((a) => a.locality_id).filter(Boolean) as string[])];
  const locs = locIds.length ? (((await db.from("geography").select("id, name").eq("workspace_id", workspaceId).in("id", locIds)).data ?? []) as Row[]) : [];
  const locName = new Map(locs.map((l) => [String(l.id), String(l.name)]));
  const assetBy = new Map(assets.map((a) => [String(a.id), { name: String(a.name), locality: a.locality_id ? locName.get(String(a.locality_id)) ?? null : null }]));
  const lite: TxLite[] = txs.map((t) => ({
    id: String(t.id), asset_id: t.asset_id as string | null, asset_name: t.asset_id ? assetBy.get(String(t.asset_id))?.name ?? null : null,
    locality: t.asset_id ? assetBy.get(String(t.asset_id))?.locality ?? null : null, period_start: t.period_start as string | null, deal_type: t.deal_type as string | null,
    area_sf: num(t.area_sf), rent_min: num(t.rent_min), rent_max: num(t.rent_max), rent_basis: t.rent_basis as string | null, tenant: (t.tenant_name_raw as string | null) ?? null, source_object_id: t.source_object_id as string | null,
  }));
  return { ...comparables(lite, q), localities: [...new Set(lite.map((t) => t.locality).filter(Boolean) as string[])].sort() };
}

// ------------------------------------------------------------------ market notes
export const MarketNoteInput = z.object({
  metric: z.string().min(1).max(80),
  geography: z.string().min(1).max(120),
  title: z.string().min(2).max(200).optional().nullable(),
  audience: z.string().max(80).optional().nullable(),
});

const Commentary = z.object({ commentary: z.string().max(2000) });

/**
 * Draft a market note: facts are computed deterministically from GATED observations; the commentary is AI-drafted (or a
 * deterministic template in mock / budget mode), labelled, descriptive only. Draft status — never published automatically.
 */
export async function draftMarketNote(db: Db, workspaceId: string, raw: z.input<typeof MarketNoteInput>, opts: { userId: string; ai?: AiCall }) {
  const input = MarketNoteInput.parse(raw);
  const overview = await marketOverview(db, workspaceId);
  const s = overview.series.find((x) => x.metric === input.metric && (x.geography === input.geography || x.geographyLabel === input.geography));
  if (!s) throw new Error("No gated observations for that metric and geography.");
  const facts = factsFromTrend(s.metric, s.geographyLabel, s.points);
  const gaps = s.points.filter((p) => p.value === null).map((p) => p.label);
  const notComparable = s.points.filter((p) => p.comparable_to_previous === false).map((p) => p.note ?? p.label);
  const mock = () => ({
    commentary: [
      `This note describes ${s.metric.replace(/_/g, " ")} for ${s.geographyLabel} from validated releases only.`,
      gaps.length ? `No observation exists for ${gaps.join(", ")}; those periods are unknown, not zero.` : "",
      notComparable.length ? `Some periods are not directly comparable: ${notComparable.join(" ")}` : "",
      s.kind === "stock" ? "Stock is a point-in-time snapshot and is not added across years." : "",
      "This is not a forecast.",
    ].filter(Boolean).join(" "),
  });
  let commentary = mock().commentary;
  let label = "Template commentary (AI not used) — descriptive only, not a forecast. Verify before sharing.";
  try {
    const res = await (opts.ai ?? (callStructured as AiCall))({
      workspaceId, workflow: "market.note", tier: "luna",
      system: "You write short, descriptive commentary on Pune office market data for a CRE adviser. Use ONLY the facts given; do not compute new numbers, do not forecast, do not infer vacancy from absorption, do not sum stock across years. State gaps as unknown.",
      input: `Metric: ${s.metric}\nGeography: ${s.geographyLabel}\nKind: ${s.kind}\nUnknown periods: ${gaps.join(", ") || "none"}\nNot comparable: ${notComparable.join(" ") || "none"}`,
      evidence: facts.map((f) => f.text).join("\n"), schema: Commentary, schemaName: "market_commentary", maxOutputTokens: 600, mock,
    });
    commentary = res.data.commentary;
    if (!res.mocked) label = "AI-drafted commentary — descriptive only, not a forecast. Verify before sharing.";
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e;
    label = `Template commentary (AI unavailable: ${e.reason}) — descriptive only, not a forecast.`;
  }
  const body = [...facts.map((f) => `• ${f.text}`), "", commentary, "", MARKET_DISCLAIMER].join("\n");
  const { data, error } = await db.from("market_note").insert({
    workspace_id: workspaceId, title: input.title ?? `${s.metric.replace(/_/g, " ")} — ${s.geographyLabel}`, geography_raw: s.geographyLabel, metric: s.metric,
    period_label: s.points.filter((p) => p.value !== null).map((p) => p.label).join(", "), body, facts, commentary, commentary_label: label,
    audience: input.audience ?? null, status: "draft", owner_user_id: opts.userId,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function setMarketNoteStatus(db: Db, workspaceId: string, id: string, status: "draft" | "in_review" | "approved" | "published_manually" | "discarded", confidentialityChecked?: boolean) {
  const patch: Row = { status };
  if (confidentialityChecked !== undefined) patch.confidentiality_checked = confidentialityChecked;
  if ((status === "approved" || status === "published_manually")) {
    const { data: cur } = await db.from("market_note").select("confidentiality_checked").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!cur) throw new Error("not found");
    if (!cur.confidentiality_checked && !confidentialityChecked) throw new Error("Confirm the confidentiality check before approving.");
  }
  const { data, error } = await db.from("market_note").update(patch).eq("workspace_id", workspaceId).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

export async function listMarketNotes(db: Db, workspaceId: string) {
  const { data, error } = await db.from("market_note").select("id, title, metric, geography_raw, period_label, status, commentary_label, confidentiality_checked, created_at, body").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as Row[];
}
