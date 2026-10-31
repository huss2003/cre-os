/**
 * Design studio + release guard (spec Part III POST /v1/documents/generate: "template/access/freshness guards, editable
 * output and preview QA"). Files go to storage mudar-workspace-files/<ws>/documents/<doc>.<ext>; every document_version
 * records the sha256 and the exact input versions it was built from. A stale document can never be approved/released
 * (also enforced by the document_version_deals_guard trigger).
 */
import { createHash, randomUUID } from "node:crypto";
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import { compareScenarios } from "../finance/engine";
import type { FinanceInput, FinanceResult } from "../finance/types";
import { REQUIREMENT_FIELDS, fieldStatus, fieldValue, missingQuestions, type RequirementRow } from "../requirements/contract";
import { isStale } from "../matching/match";
import { quoteLeakageCheck, type LeakageIssue } from "../quotes/service";
import { runEngine } from "../finance/service";
import { brandFrom, type DocModel, type OptionLine } from "./model";
import { buildComparisonXlsx } from "./xlsx";
import { buildShortlistPptx } from "./pptx";
import { buildProposalDocx } from "./docx";
import { buildMarketNoteDocx } from "./market-note";
import { extractTemplateTheme, type TemplateTheme } from "./theme";
import { buildMapModel, type MapPointIn } from "./visuals";
import type { MarketSection } from "./model";

export const BUCKET = "mudar-workspace-files";
export type Purpose = DocModel["purpose"];
export const PURPOSES: { purpose: Purpose; kind: "pptx" | "docx" | "xlsx"; label: string }[] = [
  { purpose: "shortlist_deck", kind: "pptx", label: "Shortlist deck (PPTX)" },
  { purpose: "proposal", kind: "docx", label: "Proposal (DOCX)" },
  { purpose: "market_note", kind: "docx", label: "Market note (DOCX)" },
  { purpose: "comparison_xlsx", kind: "xlsx", label: "Financial comparison (XLSX)" },
];
const MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
export const mimeFor = (kind: string) => MIME[kind as keyof typeof MIME] ?? "application/octet-stream";

export interface InputVersions {
  requirement?: Record<string, number>;
  geographies?: Record<string, number>;
  market_observations?: Record<string, number>;
  quotes?: Record<string, number>;
  scenarios?: Record<string, string>;
  shortlist?: Record<string, number>;
  availability?: Record<string, string>;
  template?: Record<string, number>;
}

export interface GenerateInput { purpose: Purpose; requirementId: string; scenarioIds?: string[]; shortlistVersion?: number | null; preparedFor?: string | null }

const fmtNum = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("en-IN"));
const fmtVal = (v: unknown): string => Array.isArray(v) ? (v.every((x) => x === null) ? "—" : v.map(fmtNum).join(" / ")) : v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? fmtNum(v) : String(v);

/** Collect inputs and build the document model (no side effects). */
export async function assembleModel(ctx: DealsCtx, g: GenerateInput, asOf = today()): Promise<{ model: DocModel; inputs: InputVersions; quotes: Record<string, unknown>[]; templateId: string | null; templateVersion: number | null; warnings: string[] }> {
  const purposeDef = PURPOSES.find((p) => p.purpose === g.purpose);
  if (!purposeDef) throw new DealsError(400, `unknown purpose ${g.purpose}`);
  const req = must(await ctx.db.from("requirement").select("*, organisation:org_id(display_name)").eq("id", g.requirementId).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown> & { organisation: { display_name: string } | null };
  const warnings: string[] = [];
  const inputs: InputVersions = { requirement: { [g.requirementId]: Number(req.row_version) } };

  // template + brand (per-tenant configuration; never hardcoded)
  const tpl = (await ctx.db.from("template_asset").select("id, name, version, brand_json, approved, storage_path").eq("workspace_id", ctx.workspaceId)
    .eq("purpose", g.purpose).eq("kind", purposeDef.kind).is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as { id: string; name: string; version: number; brand_json: Record<string, unknown>; approved: boolean; storage_path: string | null } | null;
  const ws = (await ctx.db.from("workspace").select("name").eq("id", ctx.workspaceId).maybeSingle()).data as { name: string } | null;
  if (!tpl) warnings.push("No tenant template configured for this purpose: built-in neutral layout used (add one under template_asset).");
  else if (!tpl.approved) warnings.push(`Template "${tpl.name}" v${tpl.version} is not approved yet.`);
  if (tpl) inputs.template = { [tpl.id]: tpl.version };
  const theme = tpl?.storage_path ? await loadTemplateTheme(ctx, tpl.storage_path, purposeDef.kind) : null;
  if (theme) warnings.push(...theme.warnings);
  const brand = brandFrom(tpl?.brand_json, ws?.name ?? "CRE OS", theme);
  const templateCarryOver = !tpl ? ["Template: built-in neutral layout (no tenant template configured)."]
    : !tpl.storage_path ? [`Template "${tpl.name}" v${tpl.version}: brand settings only (no master file uploaded).`]
    : [`Uploaded master "${tpl.name}" v${tpl.version} — carried over: ${theme?.carried.length ? theme.carried.join("; ") : "nothing readable"}.`,
       `Not carried over from the master: ${(theme?.notCarried ?? []).join("; ")}. Explicit brand settings override the master's theme.`];

  // shortlist
  let options: OptionLine[] = [];
  let availRows: { id: string; as_of: string; status: string; asking_rent_min: string | null; asking_rent_max: string | null; rent_basis: string | null; fact_status: string }[] = [];
  let assetById = new Map<string, { id: string; name: string; lat: string | null; lon: string | null; locality: string | null }>();
  let shortlistRubric: string | null = null;
  const sv = (await (g.shortlistVersion
    ? ctx.db.from("shortlist_version").select("*").eq("requirement_id", g.requirementId).eq("version", g.shortlistVersion).maybeSingle()
    : ctx.db.from("shortlist_version").select("*").eq("requirement_id", g.requirementId).order("version", { ascending: false }).limit(1).maybeSingle())).data as { id: string; version: number; as_of: string } | null;
  if (sv) {
    inputs.shortlist = { [sv.id]: sv.version };
    shortlistRubric = (sv as { rubric_version?: string }).rubric_version ?? null;
    const opts = ((await ctx.db.from("shortlist_option").select("*").eq("requirement_id", g.requirementId).eq("version", sv.version)).data ?? []) as Record<string, unknown>[];
    const avIds = opts.map((o) => o.availability_id).filter(Boolean) as string[];
    const avs = avIds.length ? ((await ctx.db.from("availability").select("id, as_of, status, available_from, valid_until, asking_rent_min, asking_rent_max, rent_basis, fact_status").in("id", avIds)).data ?? []) : [];
    availRows = avs as typeof availRows;
    const assetIds = [...new Set(opts.map((o) => o.asset_id).filter(Boolean))] as string[];
    const assets = assetIds.length ? (((await ctx.db.from("asset").select("id, name, lat, lon, locality_id, micro_market_id").in("id", assetIds)).data ?? []) as { id: string; name: string; lat: string | null; lon: string | null; locality_id: string | null; micro_market_id: string | null }[]) : [];
    const geoIds = [...new Set(assets.flatMap((a) => [a.locality_id, a.micro_market_id]).filter(Boolean))] as string[];
    const geos = geoIds.length ? (((await ctx.db.from("geography").select("id, name").in("id", geoIds)).data ?? []) as { id: string; name: string }[]) : [];
    assetById = new Map(assets.map((a) => [a.id, { ...a, locality: geos.find((x) => x.id === (a.micro_market_id ?? a.locality_id))?.name ?? null }]));
    const avById = new Map(avs.map((a) => [a.id as string, a]));
    inputs.availability = Object.fromEntries(avs.map((a) => [a.id as string, a.as_of as string]));
    options = opts.map((o) => {
      const b = (o.score_breakdown ?? {}) as { rank?: number; label?: string; eligibility?: string; area?: { value: number | null; basis: string | null; derived: boolean }; allInCostPerUnit?: number | null; flags?: Record<string, boolean>; verificationNeeded?: string[] };
      const av = o.availability_id ? avById.get(o.availability_id as string) : null;
      const asset = o.asset_id ? assetById.get(o.asset_id as string) : undefined;
      const flags: string[] = [];
      if (b.flags?.vacancyUnverified) flags.push("Vacancy unverified");
      if (b.flags?.availabilityStale) flags.push("Availability observation stale — recheck before sending");
      if (b.flags?.quoteExpired) flags.push("Quote expired or superseded");
      return {
        rank: b.rank ?? 0, label: b.label ?? String(o.space_id), eligibility: b.eligibility ?? (o.eligible ? "eligible" : "ineligible"),
        fitScore: o.fit_score === null ? null : Number(o.fit_score), completenessScore: o.completeness_score === null ? null : Number(o.completeness_score),
        area: b.area?.value ? `${fmtNum(b.area.value)} SF ${b.area.basis ?? ""}${b.area.derived ? " (derived)" : ""}`.trim() : "unknown",
        cost: b.allInCostPerUnit ? `₹${fmtNum(b.allInCostPerUnit)} / unit / month` : "unknown",
        availability: av ? `${av.status}${av.available_from ? ` from ${av.available_from}` : ""} (as of ${av.as_of})` : "no snapshot — unverified",
        flags, disqualifiers: (o.disqualifiers ?? []) as string[], verification: b.verificationNeeded ?? [],
        areaSf: b.area?.value ?? null, costPerUnit: b.allInCostPerUnit ?? null,
        lat: asset?.lat == null ? null : Number(asset.lat), lon: asset?.lon == null ? null : Number(asset.lon), locality: asset?.locality ?? null,
      };
    }).sort((a, b) => a.rank - b.rank);
  } else if (g.purpose !== "comparison_xlsx") warnings.push("No shortlist run yet for this requirement.");

  // finance scenarios (re-verified: stored hash must reproduce)
  const scenarios: FinanceResult[] = [];
  const inputsFin: FinanceInput[] = [];
  const annualRatePct: Record<string, string> = {};
  if (g.scenarioIds?.length) {
    const rows = ((await ctx.db.from("finance_scenario").select("id, name, input_json, output_hash, approved_at").in("id", g.scenarioIds)).data ?? []) as { id: string; name: string; input_json: FinanceInput; output_hash: string; approved_at: string | null }[];
    if (rows.length !== g.scenarioIds.length) throw new DealsError(404, "one or more finance scenarios not found");
    inputs.scenarios = {};
    for (const id of g.scenarioIds) {
      const r = rows.find((x) => x.id === id)!;
      const res = runEngine(r.input_json);
      if (res.outputHash !== r.output_hash) throw new DealsError(409, `scenario "${r.name}" no longer reproduces: re-run it`);
      if (!r.approved_at) warnings.push(`Scenario "${r.name}" is not approved.`);
      scenarios.push(res); inputsFin.push(r.input_json);
      annualRatePct[res.outputHash] = String(r.input_json.annualDiscountRatePct);
      inputs.scenarios[id] = r.output_hash;
    }
  } else if (g.purpose === "comparison_xlsx") throw new DealsError(400, "select at least one saved finance scenario");
  let comparison: ReturnType<typeof compareScenarios>["rows"] = [];
  if (inputsFin.length) {
    try { comparison = compareScenarios(inputsFin).rows; } catch (e) { throw new DealsError(400, (e as Error).message); }
  }

  // quotes: current quotes on the requirement + those referenced by scenarios
  const quoteIds = new Set<string>();
  for (const f of inputsFin) for (const q of f.quoteRefs ?? []) quoteIds.add(q.quoteId);
  const reqQuotes = ((await ctx.db.from("quote").select("*").eq("requirement_id", g.requirementId).is("superseded_by", null)).data ?? []) as Record<string, unknown>[];
  for (const q of reqQuotes) quoteIds.add(q.id as string);
  const quotes = quoteIds.size ? (((await ctx.db.from("quote").select("*").in("id", [...quoteIds])).data ?? []) as Record<string, unknown>[]) : [];
  inputs.quotes = Object.fromEntries(quotes.map((q) => [q.id as string, Number(q.version)]));

  const reqLines: [string, string][] = REQUIREMENT_FIELDS.filter((f) => f.mandatory || fieldValue(req, f.key) != null)
    .map((f) => [f.label, `${fmtVal(fieldValue(req, f.key))}${fieldStatus(req, f.key) === "estimated" ? " (estimated)" : fieldStatus(req, f.key) === "unknown" ? " (unknown)" : ""}`] as [string, string])
    .filter(([, v]) => !v.startsWith("—") || true).slice(0, 24);
  const clientName = req.organisation?.display_name ?? "Client";
  const freshness = [
    `Requirement "${req.title}" v${req.row_version} — ${req.status === "client_confirmed" ? "client confirmed" : "not client confirmed"}`,
    ...(sv ? [`Shortlist run v${sv.version} as of ${sv.as_of} (rubric match-v1)`] : []),
    ...Object.entries(inputs.availability ?? {}).length ? [`${Object.keys(inputs.availability ?? {}).length} availability observations; oldest as of ${Object.values(inputs.availability ?? {}).sort()[0]}`] : [],
    ...quotes.map((q) => `Quote v${q.version}${q.valid_until ? ` valid until ${q.valid_until}` : " (no validity date)"}${q.superseded_by ? " — SUPERSEDED" : ""}`),
    `Generated ${new Date().toISOString()} (as of ${asOf})`,
  ];
  const assumptions = [
    ...scenarios.map((s) => `${s.name}: ${s.horizonMonths}-month horizon from ${s.baseDate}, monthly discount rate ${s.monthlyDiscountRate}, engine ${s.engineVersion}`),
    ...[...new Set(scenarios.flatMap((s) => s.warnings))],
    "Areas quoted are space snapshots, not building totals. Unknown values are shown as unknown.",
  ];
  const titles: Record<Purpose, string> = {
    shortlist_deck: `Office options — ${req.title}`, proposal: `Proposal — ${req.title}`,
    market_note: `Market note — ${req.title}`, comparison_xlsx: `Financial comparison — ${req.title}`,
  };
  // preferred micro-markets (map + market note)
  const prefIds = ((req as unknown as { preferred_geography_ids?: string[] | null }).preferred_geography_ids ?? []) as string[];
  const prefGeos = prefIds.length ? (((await ctx.db.from("geography").select("id, name, lat, lon, row_version").in("id", prefIds)).data ?? []) as { id: string; name: string; lat: string | null; lon: string | null; row_version: number }[]) : [];
  if (prefGeos.length) inputs.geographies = Object.fromEntries(prefGeos.map((x) => [x.id, Number(x.row_version)]));
  const mapIn: MapPointIn[] = [
    ...options.filter((o) => o.eligibility !== "ineligible").slice(0, 12).map((o) => ({ label: `${o.rank}. ${o.label}`, lat: o.lat ?? null, lon: o.lon ?? null, kind: "option" as const })),
    ...prefGeos.map((x) => ({ label: x.name, lat: x.lat == null ? null : Number(x.lat), lon: x.lon == null ? null : Number(x.lon), kind: "preferred_area" as const })),
  ];
  const map = buildMapModel(mapIn);
  if (!map && mapIn.length) warnings.push("Location map skipped: no stored coordinates for the options or preferred areas.");
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const r0 = req as unknown as Record<string, unknown>;
  const targets = { areaMinSf: n(r0.area_min_sf), areaTargetSf: n(r0.area_target_sf), areaMaxSf: n(r0.area_max_sf), areaBasis: (r0.area_basis as string) ?? null,
    budgetMin: n(r0.budget_min), budgetMax: n(r0.budget_max), budgetBasis: (r0.budget_basis as string) ?? null };

  let market: MarketSection | null = null;
  const obsRows: { id: string; metric: string; geography_raw: string | null; geography_id: string | null; period_type: string; period_start: string | null; period_end: string | null; value: string | null; unit: string; source_version: string | null; release_date: string | null; row_version: number }[] = [];
  if (g.purpose === "market_note") {
    const geoIdsForObs = [...new Set([...prefIds])];
    if (geoIdsForObs.length) obsRows.push(...(((await ctx.db.from("market_observation").select("id, metric, geography_raw, geography_id, period_type, period_start, period_end, value, unit, source_version, release_date, row_version")
      .in("geography_id", geoIdsForObs).is("archived_at", null).order("period_end", { ascending: false, nullsFirst: false }).limit(25)).data ?? []) as typeof obsRows));
    if (obsRows.length) inputs.market_observations = Object.fromEntries(obsRows.map((o) => [o.id, Number(o.row_version)]));
    const counts = new Map<string, number>();
    for (const a of availRows) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    const rents = availRows.flatMap((a) => [n(a.asking_rent_min), n(a.asking_rent_max)]).filter((x): x is number => x !== null);
    const bases = [...new Set(availRows.map((a) => a.rent_basis).filter(Boolean))];
    const asOfs = availRows.map((a) => a.as_of).sort();
    market = {
      geographies: prefGeos.map((x) => x.name),
      availabilitySummary: [...counts.entries()].map(([status, count]) => ({ status, count })),
      askingRent: { min: rents.length && bases.length <= 1 ? Math.min(...rents) : null, max: rents.length && bases.length <= 1 ? Math.max(...rents) : null,
        basis: bases.length === 1 ? String(bases[0]) : bases.length > 1 ? "mixed bases — not combined" : null, observations: rents.length ? availRows.filter((a) => a.asking_rent_min || a.asking_rent_max).length : 0,
        asOfRange: asOfs.length ? (asOfs[0] === asOfs[asOfs.length - 1] ? asOfs[0] : `${asOfs[0]} to ${asOfs[asOfs.length - 1]}`) : null },
      observations: obsRows.map((o) => ({ metric: o.metric, geography: o.geography_raw ?? prefGeos.find((x) => x.id === o.geography_id)?.name ?? "—",
        period: `${o.period_type}${o.period_start || o.period_end ? ` ${o.period_start ?? "?"}–${o.period_end ?? "?"}` : ""}`, value: o.value === null ? "unknown" : String(Number(o.value)), unit: o.unit,
        source: `${o.source_version ?? "stored source"}${o.release_date ? ` (released ${o.release_date})` : ""}` })),
    };
  }

  const sid = (id: string) => id.slice(0, 8);
  const sources = [
    `Requirement "${req.title}" (${sid(g.requirementId)}) row version ${req.row_version} — ${req.status}`,
    ...(sv ? [`Shortlist run v${sv.version} (${sid(sv.id)}), rubric ${shortlistRubric ?? "match-v1"}, as of ${sv.as_of}`] : ["Shortlist: none"]),
    ...availRows.slice(0, 15).map((a) => `Availability ${sid(a.id)}: ${a.status} as of ${a.as_of} (${a.fact_status.replace(/_/g, " ")})`),
    ...(availRows.length > 15 ? [`… and ${availRows.length - 15} more availability snapshots`] : []),
    ...quotes.map((q) => `Quote ${sid(String(q.id))} v${q.version}${q.valid_until ? `, valid until ${q.valid_until}` : ""}${q.superseded_by ? " (superseded)" : ""}`),
    ...scenarios.map((s, i) => `Finance scenario "${s.name}" (${sid(g.scenarioIds![i])}): engine ${s.engineVersion}, output hash ${s.outputHash.slice(0, 16)}`),
    ...prefGeos.map((x) => `Geography "${x.name}" (${sid(x.id)}) v${x.row_version}${x.lat == null ? " — no coordinates" : ""}`),
    ...obsRows.map((o) => `Market observation ${sid(o.id)}: ${o.metric} ${o.period_type} ${o.period_end ?? ""} (${o.source_version ?? "stored source"})`),
    tpl ? `Template "${tpl.name}" (${sid(tpl.id)}) v${tpl.version} — ${tpl.approved ? "approved" : "NOT approved"}` : "Template: built-in neutral layout",
  ];

  const model: DocModel = {
    purpose: g.purpose, title: titles[g.purpose], clientName, preparedFor: g.preparedFor ?? null, generatedAt: new Date().toISOString(),
    brand, template: { id: tpl?.id ?? null, version: tpl?.version ?? null, name: tpl?.name ?? "Built-in neutral template" },
    requirement: { title: String(req.title), status: String(req.status), lines: reqLines, missing: missingQuestions(req).filter((q) => q.priority === "mandatory").map((q) => q.question) },
    options, scenarios, annualRatePct, comparison, assumptions, freshness,
    watermark: `Confidential — prepared for ${clientName}${g.preparedFor ? ` (${g.preparedFor})` : ""}. Not for onward distribution.`,
    sources, targets, map, templateCarryOver, market,
  };
  return { model, inputs, quotes, templateId: tpl?.id ?? null, templateVersion: tpl?.version ?? null, warnings };
}

export async function renderModel(model: DocModel): Promise<{ buffer: Buffer; kind: "pptx" | "docx" | "xlsx" }> {
  switch (model.purpose) {
    case "shortlist_deck": return { buffer: await buildShortlistPptx(model), kind: "pptx" };
    case "proposal": return { buffer: await buildProposalDocx(model), kind: "docx" };
    case "market_note": return { buffer: await buildMarketNoteDocx(model), kind: "docx" };
    case "comparison_xlsx": return { buffer: (await buildComparisonXlsx(model)).buffer, kind: "xlsx" };
  }
}

/**
 * Generate a new version. The row is created first (the DB assigns family / parent / version number — earlier
 * versions, including approved and released ones, are never touched), then the file is rendered with that version
 * number, stored, and bound to the row by its sha256.
 */
export async function generateDocument(ctx: DealsCtx, g: GenerateInput) {
  const { model, inputs, templateId, templateVersion, warnings } = await assembleModel(ctx, g);
  const id = randomUUID();
  const cls = ((await ctx.db.from("requirement").select("classification").eq("id", g.requirementId).maybeSingle()).data as { classification: string } | null)?.classification ?? "corporate_confidential";
  const kind = PURPOSES.find((p) => p.purpose === g.purpose)!.kind;
  const request = { purpose: g.purpose, requirementId: g.requirementId, scenarioIds: g.scenarioIds ?? [], preparedFor: g.preparedFor ?? null };
  const row = await ctx.db.from("document_version").insert({
    id, ...owned(ctx, cls), kind, purpose: g.purpose, uri: null, sha256: null, template_asset_id: templateId, template_version: templateVersion,
    input_versions: { ...inputs, generation_warnings: warnings, title: model.title, prepared_for: g.preparedFor ?? null, request, sources: model.sources ?? [], template_carry_over: model.templateCarryOver ?? [] },
    status: "draft", linked_entity_type: "requirement", linked_entity_id: g.requirementId,
  }).select("id, family_id, parent_id, version_no").single();
  if (row.error) throw dbError(row.error, "document_version");
  const lineage = row.data as { family_id: string; parent_id: string | null; version_no: number };
  model.version = { no: lineage.version_no, familyId: lineage.family_id, parentId: lineage.parent_id };
  model.sources = [...(model.sources ?? []), `This document: version ${lineage.version_no} of family ${lineage.family_id.slice(0, 8)}${lineage.parent_id ? ` (previous version ${lineage.parent_id.slice(0, 8)} kept)` : ""}`];
  const path = `${ctx.workspaceId}/documents/${id}.${kind}`;
  try {
    const { buffer } = await renderModel(model);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const up = await ctx.db.storage.from(BUCKET).upload(path, buffer, { contentType: mimeFor(kind), upsert: false });
    if (up.error) throw new DealsError(500, `storage upload failed: ${up.error.message}`);
    const done = await ctx.db.from("document_version").update({ uri: `${BUCKET}/${path}`, sha256 }).eq("id", id).select("*").single();
    if (done.error) { await ctx.db.storage.from(BUCKET).remove([path]); throw dbError(done.error, "document_version"); }
    return { document: done.data, warnings, bytes: buffer.length };
  } catch (e) {
    await ctx.db.from("document_version").update({ archived_at: new Date().toISOString() }).eq("id", id);
    throw e;
  }
}

/** New version of an existing document from CURRENT inputs (same purpose, requirement, scenarios, recipient). */
export async function regenerateDocument(ctx: DealsCtx, id: string) {
  const doc = must(await ctx.db.from("document_version").select("purpose, linked_entity_id, input_versions").eq("id", id).maybeSingle(), "document") as { purpose: Purpose; linked_entity_id: string; input_versions: InputVersions & { request?: GenerateInput; prepared_for?: string | null } };
  const iv = doc.input_versions ?? {};
  const g: GenerateInput = iv.request ?? { purpose: doc.purpose, requirementId: doc.linked_entity_id, scenarioIds: Object.keys(iv.scenarios ?? {}), preparedFor: iv.prepared_for ?? null };
  return generateDocument(ctx, { ...g, shortlistVersion: null });
}

/** Download the uploaded master and read its theme; failures degrade to brand settings with a visible warning. */
async function loadTemplateTheme(ctx: DealsCtx, storagePath: string, kind: "pptx" | "docx" | "xlsx"): Promise<TemplateTheme | null> {
  if (!storagePath.startsWith(`${ctx.workspaceId}/templates/`)) return { carried: [], notCarried: [], warnings: ["template file path is outside this workspace — ignored"] };
  const dl = await ctx.db.storage.from(BUCKET).download(storagePath);
  if (dl.error || !dl.data) return { carried: [], notCarried: [], warnings: [`uploaded template file could not be read (${dl.error?.message ?? "missing"}) — brand settings used`] };
  const buf = Buffer.from(await dl.data.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) return { carried: [], notCarried: [], warnings: ["uploaded template is larger than 25 MB — ignored"] };
  return extractTemplateTheme(buf, kind);
}

/** Compare a document's recorded inputs with the current state. Returns reasons it is stale (empty = fresh). */
export async function stalenessReasons(ctx: DealsCtx, doc: { input_versions: InputVersions }, asOf = today(), decayDays = 30): Promise<string[]> {
  const iv = doc.input_versions ?? {};
  const out: string[] = [];
  for (const [id, ver] of Object.entries(iv.requirement ?? {})) {
    const r = (await ctx.db.from("requirement").select("row_version").eq("id", id).maybeSingle()).data as { row_version: number } | null;
    if (!r) out.push("requirement no longer visible");
    else if (Number(r.row_version) !== Number(ver)) out.push("requirement changed after generation");
  }
  const qIds = Object.keys(iv.quotes ?? {});
  if (qIds.length) {
    const qs = ((await ctx.db.from("quote").select("id, version, valid_until, superseded_by").in("id", qIds)).data ?? []) as { id: string; version: number; valid_until: string | null; superseded_by: string | null }[];
    for (const id of qIds) {
      const q = qs.find((x) => x.id === id);
      if (!q) out.push(`quote ${id} no longer visible`);
      else if (q.superseded_by) out.push(`quote v${q.version} superseded`);
      else if (q.valid_until && q.valid_until < asOf) out.push(`quote v${q.version} expired ${q.valid_until}`);
    }
  }
  const sIds = Object.keys(iv.scenarios ?? {});
  if (sIds.length) {
    const ss = ((await ctx.db.from("finance_scenario").select("id, name, output_hash").in("id", sIds)).data ?? []) as { id: string; name: string; output_hash: string }[];
    for (const id of sIds) {
      const s = ss.find((x) => x.id === id);
      if (!s) out.push("finance scenario no longer visible");
      else if (s.output_hash !== iv.scenarios![id]) out.push(`scenario "${s.name}" recalculated since generation`);
    }
  }
  const avIds = Object.keys(iv.availability ?? {});
  if (avIds.length) {
    const avs = ((await ctx.db.from("availability").select("id, space_id, as_of, valid_until, status").in("id", avIds)).data ?? []) as { id: string; space_id: string; as_of: string; valid_until: string | null; status: string }[];
    const staleCount = avs.filter((a) => isStale(a as never, asOf, decayDays)).length;
    if (staleCount) out.push(`${staleCount} availability observation(s) past validity — recheck before sending`);
    const spaceIds = [...new Set(avs.map((a) => a.space_id))];
    if (spaceIds.length) {
      const newer = ((await ctx.db.from("availability").select("id, space_id, as_of").in("space_id", spaceIds).order("as_of", { ascending: false })).data ?? []) as { id: string; space_id: string; as_of: string }[];
      const changed = avs.filter((a) => newer.some((n) => n.space_id === a.space_id && n.as_of > a.as_of)).length;
      if (changed) out.push(`${changed} option(s) have newer availability snapshots`);
    }
  }
  return out;
}

/** Mark stale with reasons (released documents too: they must be re-reviewed before sharing again). */
async function markStale(ctx: DealsCtx, id: string, doc: { status: string; stale_reasons?: unknown }, reasons: string[]) {
  if (doc.status === "stale") return;
  const prev = Array.isArray(doc.stale_reasons) ? doc.stale_reasons : [];
  const at = new Date().toISOString();
  const r = await ctx.db.from("document_version").update({ status: "stale", stale_at: at, stale_reasons: [...prev, ...reasons.map((reason) => ({ reason, at, was: doc.status }))] }).eq("id", id);
  if (r.error) throw dbError(r.error, "document");
}

/** Re-check and mark stale when needed. */
export async function refreshStatus(ctx: DealsCtx, id: string) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; input_versions: InputVersions; stale_reasons: unknown };
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length) await markStale(ctx, id, doc, reasons);
  return { reasons, status: reasons.length ? "stale" : doc.status };
}

export async function approveDocument(ctx: DealsCtx, id: string) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; sha256: string; input_versions: InputVersions; stale_reasons: unknown };
  if (doc.status === "stale") throw new DealsError(422, "document is stale: regenerate it");
  if (!doc.sha256) throw new DealsError(422, "document file is not ready");
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length) {
    await markStale(ctx, id, doc, reasons);
    throw new DealsError(422, "document is stale: regenerate it", { reasons });
  }
  const r = await ctx.db.from("document_version").update({ status: "approved", approved_hash: doc.sha256 }).eq("id", id).select("*").single();
  if (r.error) throw dbError(r.error, "document");
  await ctx.db.from("approval").insert({ ...owned(ctx), subject_type: "document_version", subject_id: id, approver_user_id: ctx.userId, approved_hash: doc.sha256, decision: "approved" });
  return r.data;
}

/** Client-ready release: fresh inputs, approved hash, quote leakage checks, recipient recorded. */
export async function releaseDocument(ctx: DealsCtx, id: string, opts: { recipient: string }) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; sha256: string; approved_hash: string | null; input_versions: InputVersions & Record<string, unknown>; stale_reasons: unknown };
  if (doc.status !== "approved") throw new DealsError(422, `document must be approved first (status: ${doc.status})`);
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length) {
    await markStale(ctx, id, doc, reasons);
    throw new DealsError(422, "document is stale: regenerate it", { reasons });
  }
  const qIds = Object.keys(doc.input_versions.quotes ?? {});
  const issues: (LeakageIssue & { quoteId: string })[] = [];
  if (qIds.length) {
    const qs = ((await ctx.db.from("quote").select("*").in("id", qIds)).data ?? []) as { id: string; version: number; valid_until: string | null; superseded_by: string | null; terms_json: Record<string, unknown>; evidence: string | null }[];
    for (const q of qs) for (const i of quoteLeakageCheck(q, { asOf: today(), recipient: opts.recipient, watermark: true })) issues.push({ ...i, quoteId: q.id });
  }
  if (!opts.recipient?.trim()) throw new DealsError(422, "record the recipient before release");
  const blocking = issues.filter((i) => i.blocking);
  if (blocking.length) throw new DealsError(422, "quote leakage check failed", { issues: blocking });
  const r = await ctx.db.from("document_version").update({
    status: "released", input_versions: { ...doc.input_versions, released_to: opts.recipient.trim(), released_at: new Date().toISOString(), release_warnings: issues.map((i) => i.message) },
  }).eq("id", id).select("*").single();
  if (r.error) throw dbError(r.error, "document");
  return { document: r.data, warnings: issues.map((i) => i.message) };
}

/** Download through RLS: the row must be visible to the caller, then storage policy applies again. */
export async function downloadDocument(ctx: DealsCtx, id: string): Promise<{ buffer: Buffer; fileName: string; mime: string; sha256: string }> {
  const doc = must(await ctx.db.from("document_version").select("id, kind, uri, sha256, purpose, workspace_id, version_no").eq("id", id).maybeSingle(), "document") as { id: string; kind: string; uri: string | null; sha256: string | null; purpose: string; workspace_id: string; version_no: number | null };
  if (!doc.uri || !doc.sha256) throw new DealsError(404, "file not ready");
  const path = doc.uri.replace(`${BUCKET}/`, "");
  if (!path.startsWith(`${doc.workspace_id}/documents/`)) throw new DealsError(403, "unexpected storage path");
  const dl = await ctx.db.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) throw new DealsError(404, "file not found");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  const sha = createHash("sha256").update(buffer).digest("hex");
  if (sha !== doc.sha256) throw new DealsError(409, "stored file does not match its recorded hash");
  return { buffer, fileName: `${doc.purpose}-v${doc.version_no ?? 1}-${doc.id.slice(0, 8)}.${doc.kind}`, mime: mimeFor(doc.kind), sha256: sha };
}

export async function listDocuments(ctx: DealsCtx, opts: { requirementId?: string } = {}) {
  let q = ctx.db.from("document_version").select("id, kind, purpose, status, sha256, created_at, linked_entity_id, input_versions, template_version, family_id, parent_id, version_no, stale_reasons, stale_at, released_at, approved_hash")
    .eq("workspace_id", ctx.workspaceId).eq("linked_entity_type", "requirement").is("archived_at", null).not("sha256", "is", null).order("created_at", { ascending: false }).limit(300);
  if (opts.requirementId) q = q.eq("linked_entity_id", opts.requirementId);
  const r = await q;
  if (r.error) throw dbError(r.error, "documents");
  return r.data ?? [];
}
