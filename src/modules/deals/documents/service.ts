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
  const tpl = (await ctx.db.from("template_asset").select("id, name, version, brand_json, approved").eq("workspace_id", ctx.workspaceId)
    .eq("purpose", g.purpose).eq("kind", purposeDef.kind).is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as { id: string; name: string; version: number; brand_json: Record<string, unknown>; approved: boolean } | null;
  const ws = (await ctx.db.from("workspace").select("name").eq("id", ctx.workspaceId).maybeSingle()).data as { name: string } | null;
  if (!tpl) warnings.push("No tenant template configured for this purpose: built-in neutral layout used (add one under template_asset).");
  else if (!tpl.approved) warnings.push(`Template "${tpl.name}" v${tpl.version} is not approved yet.`);
  if (tpl) inputs.template = { [tpl.id]: tpl.version };
  const brand = brandFrom(tpl?.brand_json, ws?.name ?? "CRE OS");

  // shortlist
  let options: OptionLine[] = [];
  const sv = (await (g.shortlistVersion
    ? ctx.db.from("shortlist_version").select("*").eq("requirement_id", g.requirementId).eq("version", g.shortlistVersion).maybeSingle()
    : ctx.db.from("shortlist_version").select("*").eq("requirement_id", g.requirementId).order("version", { ascending: false }).limit(1).maybeSingle())).data as { id: string; version: number; as_of: string } | null;
  if (sv) {
    inputs.shortlist = { [sv.id]: sv.version };
    const opts = ((await ctx.db.from("shortlist_option").select("*").eq("requirement_id", g.requirementId).eq("version", sv.version)).data ?? []) as Record<string, unknown>[];
    const avIds = opts.map((o) => o.availability_id).filter(Boolean) as string[];
    const avs = avIds.length ? ((await ctx.db.from("availability").select("id, as_of, status, available_from, valid_until").in("id", avIds)).data ?? []) : [];
    const avById = new Map(avs.map((a) => [a.id as string, a]));
    inputs.availability = Object.fromEntries(avs.map((a) => [a.id as string, a.as_of as string]));
    options = opts.map((o) => {
      const b = (o.score_breakdown ?? {}) as { rank?: number; label?: string; eligibility?: string; area?: { value: number | null; basis: string | null; derived: boolean }; allInCostPerUnit?: number | null; flags?: Record<string, boolean>; verificationNeeded?: string[] };
      const av = o.availability_id ? avById.get(o.availability_id as string) : null;
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
  const model: DocModel = {
    purpose: g.purpose, title: titles[g.purpose], clientName, preparedFor: g.preparedFor ?? null, generatedAt: new Date().toISOString(),
    brand, template: { id: tpl?.id ?? null, version: tpl?.version ?? null, name: tpl?.name ?? "Built-in neutral template" },
    requirement: { title: String(req.title), status: String(req.status), lines: reqLines, missing: missingQuestions(req).filter((q) => q.priority === "mandatory").map((q) => q.question) },
    options, scenarios, annualRatePct, comparison, assumptions, freshness,
    watermark: `Confidential — prepared for ${clientName}${g.preparedFor ? ` (${g.preparedFor})` : ""}. Not for onward distribution.`,
  };
  return { model, inputs, quotes, templateId: tpl?.id ?? null, templateVersion: tpl?.version ?? null, warnings };
}

export async function renderModel(model: DocModel): Promise<{ buffer: Buffer; kind: "pptx" | "docx" | "xlsx" }> {
  switch (model.purpose) {
    case "shortlist_deck": return { buffer: await buildShortlistPptx(model), kind: "pptx" };
    case "proposal": case "market_note": return { buffer: await buildProposalDocx(model), kind: "docx" };
    case "comparison_xlsx": return { buffer: (await buildComparisonXlsx(model)).buffer, kind: "xlsx" };
  }
}

export async function generateDocument(ctx: DealsCtx, g: GenerateInput) {
  const { model, inputs, templateId, templateVersion, warnings } = await assembleModel(ctx, g);
  const { buffer, kind } = await renderModel(model);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const id = randomUUID();
  const path = `${ctx.workspaceId}/documents/${id}.${kind}`;
  const up = await ctx.db.storage.from(BUCKET).upload(path, buffer, { contentType: mimeFor(kind), upsert: false });
  if (up.error) throw new DealsError(500, `storage upload failed: ${up.error.message}`);
  const cls = ((await ctx.db.from("requirement").select("classification").eq("id", g.requirementId).maybeSingle()).data as { classification: string } | null)?.classification ?? "corporate_confidential";
  const row = await ctx.db.from("document_version").insert({
    id, ...owned(ctx, cls), kind, purpose: g.purpose, uri: `${BUCKET}/${path}`, sha256, template_asset_id: templateId, template_version: templateVersion,
    input_versions: { ...inputs, generation_warnings: warnings, title: model.title, prepared_for: g.preparedFor ?? null },
    status: "draft", linked_entity_type: "requirement", linked_entity_id: g.requirementId,
  }).select("*").single();
  if (row.error) {
    await ctx.db.storage.from(BUCKET).remove([path]);
    throw dbError(row.error, "document_version");
  }
  return { document: row.data, warnings, bytes: buffer.length };
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

/** Re-check and mark stale when needed. */
export async function refreshStatus(ctx: DealsCtx, id: string) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; input_versions: InputVersions };
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length && doc.status !== "stale" && doc.status !== "released") {
    const r = await ctx.db.from("document_version").update({ status: "stale" }).eq("id", id);
    if (r.error) throw dbError(r.error, "document");
  }
  return { reasons, status: reasons.length && doc.status !== "released" ? "stale" : doc.status };
}

export async function approveDocument(ctx: DealsCtx, id: string) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; sha256: string; input_versions: InputVersions };
  if (doc.status === "stale") throw new DealsError(422, "document is stale: regenerate it");
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length) {
    await ctx.db.from("document_version").update({ status: "stale" }).eq("id", id);
    throw new DealsError(422, "document is stale: regenerate it", { reasons });
  }
  const r = await ctx.db.from("document_version").update({ status: "approved", approved_hash: doc.sha256 }).eq("id", id).select("*").single();
  if (r.error) throw dbError(r.error, "document");
  await ctx.db.from("approval").insert({ ...owned(ctx), subject_type: "document_version", subject_id: id, approver_user_id: ctx.userId, approved_hash: doc.sha256, decision: "approved" });
  return r.data;
}

/** Client-ready release: fresh inputs, approved hash, quote leakage checks, recipient recorded. */
export async function releaseDocument(ctx: DealsCtx, id: string, opts: { recipient: string }) {
  const doc = must(await ctx.db.from("document_version").select("*").eq("id", id).maybeSingle(), "document") as { status: string; sha256: string; approved_hash: string | null; input_versions: InputVersions & Record<string, unknown> };
  if (doc.status !== "approved") throw new DealsError(422, `document must be approved first (status: ${doc.status})`);
  const reasons = await stalenessReasons(ctx, doc);
  if (reasons.length) {
    await ctx.db.from("document_version").update({ status: "stale" }).eq("id", id);
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
  const doc = must(await ctx.db.from("document_version").select("id, kind, uri, sha256, purpose, workspace_id").eq("id", id).maybeSingle(), "document") as { id: string; kind: string; uri: string; sha256: string; purpose: string; workspace_id: string };
  const path = doc.uri.replace(`${BUCKET}/`, "");
  if (!path.startsWith(`${doc.workspace_id}/documents/`)) throw new DealsError(403, "unexpected storage path");
  const dl = await ctx.db.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) throw new DealsError(404, "file not found");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  const sha = createHash("sha256").update(buffer).digest("hex");
  if (sha !== doc.sha256) throw new DealsError(409, "stored file does not match its recorded hash");
  return { buffer, fileName: `${doc.purpose}-${doc.id.slice(0, 8)}.${doc.kind}`, mime: mimeFor(doc.kind), sha256: sha };
}

export async function listDocuments(ctx: DealsCtx, opts: { requirementId?: string } = {}) {
  let q = ctx.db.from("document_version").select("id, kind, purpose, status, sha256, created_at, linked_entity_id, input_versions, template_version")
    .eq("workspace_id", ctx.workspaceId).eq("linked_entity_type", "requirement").is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  if (opts.requirementId) q = q.eq("linked_entity_id", opts.requirementId);
  const r = await q;
  if (r.error) throw dbError(r.error, "documents");
  return r.data ?? [];
}
