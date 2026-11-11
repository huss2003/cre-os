import "server-only";
/**
 * Property memory (spec §3.3). Historical quotations are ALWAYS returned with status "historical" and their date/source —
 * they are never presented as current pricing or availability. Rejections are explicit client rejections only.
 */
import { labels, q, today } from "../data";
import { hrefFor, item, verificationOf, type MemCtx, type MemoryItem, type Row } from "../types";

export interface ValueChange { field: "rent" | "cam"; spaceLabel: string; from: number | null; to: number | null; fromAsOf: string; toAsOf: string; source: string | null }
export interface PropertyContext {
  asset: Row;
  alternateNames: string[];
  developer: string | null; landlord: string | null; propertyManager: string | null;
  inventory: MemoryItem[];             // latest availability snapshot per space (with as-of date)
  availabilityHistory: MemoryItem[];
  quotations: MemoryItem[];             // historical — never current pricing
  latestKnownTerms: MemoryItem | null;  // most recent quote/offer, labelled with its date
  valueChanges: ValueChange[];
  clientInterest: { requirementId: string; requirementTitle: string; orgId: string | null; orgName: string | null; status: string; at: string }[];
  rejections: { requirementId: string | null; requirementTitle: string | null; orgName: string | null; reason: string; explicit: boolean; at: string; source: string }[];
  relatedRequirements: { id: string; title: string }[];
  specs: Row | null;
  unknowns: string[];
}

const QUOTE_STALE_DAYS = 30;
const age = (d: string) => Math.floor((Date.now() - Date.parse(d)) / 86_400_000);

export async function getPropertyContext(ctx: MemCtx, assetId: string): Promise<PropertyContext | null> {
  const ws = ctx.workspaceId;
  const { data: asset } = await ctx.db.from("asset").select("id, name, address, asset_kind, grade, status, floors, total_area_sf, completion_date, developer_org_id, owner_org_id, operator_org_id, specs, certifications, parent_asset_id").eq("workspace_id", ws).eq("id", assetId).maybeSingle();
  if (!asset) return null;
  const spaces = await q(ctx.db.from("space").select("id, floor_text, unit, carpet_sf, chargeable_sf").eq("workspace_id", ws).eq("asset_id", assetId).is("archived_at", null).limit(500));
  const sIds = spaces.map((s) => s.id);
  const sLabel = new Map(spaces.map((s) => [s.id, [s.floor_text, s.unit].filter(Boolean).join(" / ") || "Space"]));
  const [aliases, avail, quotes, opts, fb] = await Promise.all([
    q(ctx.db.from("entity_alias").select("raw_alias").eq("workspace_id", ws).eq("entity_type", "asset").eq("entity_id", assetId).is("archived_at", null).limit(50)),
    sIds.length ? q(ctx.db.from("availability").select("id, space_id, as_of, status, available_from, asking_rent_min, asking_rent_max, rent_basis, cam_psf_month, fact_status, source_object_id, valid_until, created_at").eq("workspace_id", ws).in("space_id", sIds).is("archived_at", null).order("as_of", { ascending: true }).limit(1000)) : Promise.resolve([] as Row[]),
    sIds.length ? q(ctx.db.from("quote").select("id, space_id, requirement_id, version, currency, valid_until, terms_json, offer, kind, evidence, superseded_by, created_at").eq("workspace_id", ws).in("space_id", sIds).is("archived_at", null).order("created_at", { ascending: false }).limit(200)) : Promise.resolve([] as Row[]),
    q(ctx.db.from("shortlist_option").select("id, requirement_id, option_status, disqualifiers, updated_at, requirement:requirement_id(id, title, org_id)").eq("workspace_id", ws).eq("asset_id", assetId).is("archived_at", null).limit(300)),
    q(ctx.db.from("meeting_property_feedback").select("id, fields, updated_at, prep:prep_id(requirement_id, org_id)").eq("workspace_id", ws).eq("asset_id", assetId).is("archived_at", null).limit(200)),
  ]);
  const orgNames = await labels(ctx, "organisation", [asset.developer_org_id, asset.owner_org_id, asset.operator_org_id, ...opts.map((o) => o.requirement?.org_id), ...fb.map((f) => f.prep?.org_id)]);
  const t = today();

  const availItems = avail.map((a) => item({ entityId: assetId, entityType: "asset", category: "availability", label: sLabel.get(a.space_id) ?? "Space",
    value: { status: a.status, rent: [a.asking_rent_min, a.asking_rent_max], cam: a.cam_psf_month, from: a.available_from },
    display: `${sLabel.get(a.space_id)}: ${a.status ?? "status unknown"}, rent ${a.asking_rent_min ?? "?"}${a.asking_rent_max && a.asking_rent_max !== a.asking_rent_min ? `–${a.asking_rent_max}` : ""} ${a.rent_basis ?? ""}, CAM ${a.cam_psf_month ?? "unknown"} — as of ${a.as_of}`,
    sourceRef: a.source_object_id ? { type: "source_object", id: a.source_object_id, label: `Availability ${a.as_of}`, href: null } : { type: "availability", id: a.id, label: `Availability ${a.as_of}`, href: null },
    observedAt: a.as_of, verification: verificationOf(a.fact_status), related: [{ type: "space", id: a.space_id }],
    status: (a.valid_until && a.valid_until < t) || age(a.as_of) > QUOTE_STALE_DAYS ? "historical" : "current" }));
  const latestBySpace = new Map<string, MemoryItem>(); for (const a of availItems) latestBySpace.set(a.related[0].id, a);
  const inventory = [...latestBySpace.values()].map((i) => ({ ...i, status: i.status }));

  const valueChanges: ValueChange[] = [];
  const bySpace = new Map<string, Row[]>(); for (const a of avail) bySpace.set(a.space_id, [...(bySpace.get(a.space_id) ?? []), a]);
  for (const [sid, list] of bySpace) for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (a.asking_rent_min != null && b.asking_rent_min != null && Number(a.asking_rent_min) !== Number(b.asking_rent_min)) valueChanges.push({ field: "rent", spaceLabel: sLabel.get(sid)!, from: Number(a.asking_rent_min), to: Number(b.asking_rent_min), fromAsOf: a.as_of, toAsOf: b.as_of, source: b.source_object_id });
    if (a.cam_psf_month != null && b.cam_psf_month != null && Number(a.cam_psf_month) !== Number(b.cam_psf_month)) valueChanges.push({ field: "cam", spaceLabel: sLabel.get(sid)!, from: Number(a.cam_psf_month), to: Number(b.cam_psf_month), fromAsOf: a.as_of, toAsOf: b.as_of, source: b.source_object_id });
  }

  const quotations = quotes.map((qq) => {
    const tj = (qq.terms_json ?? qq.offer ?? {}) as Row;
    const d = String(qq.created_at).slice(0, 10);
    return item({ entityId: assetId, entityType: "asset", category: "quote", label: `${qq.kind ?? "quote"} v${qq.version ?? 1}`, value: tj,
      display: `Quoted ${d}: rent ${tj.rent ?? "unknown"} ${tj.rent_basis ?? ""}, CAM ${tj.cam_per_sf ?? "unknown"}${qq.valid_until ? `, valid until ${qq.valid_until}` : ""} — historical quote, not current pricing${qq.superseded_by ? " (superseded)" : ""}`,
      sourceRef: { type: "quote", id: qq.id, label: qq.evidence ? `Quote: ${String(qq.evidence).slice(0, 60)}` : `Quote ${d}`, href: qq.requirement_id ? hrefFor("requirement", qq.requirement_id) : null },
      observedAt: qq.created_at, verification: "reported", version: qq.version ?? null, related: [{ type: "space", id: qq.space_id }, ...(qq.requirement_id ? [{ type: "requirement", id: qq.requirement_id }] : [])],
      status: qq.superseded_by ? "superseded" : "historical" });
  });

  const reqTitle = new Map<string, string>(); for (const o of opts) if (o.requirement) reqTitle.set(o.requirement.id, o.requirement.title);
  const rejections: PropertyContext["rejections"] = [
    ...fb.filter((f) => f.fields?.interest === "rejected" && f.fields?.explicit_rejection === true).map((f) => ({
      requirementId: f.prep?.requirement_id ?? null, requirementTitle: f.prep?.requirement_id ? reqTitle.get(f.prep.requirement_id) ?? null : null, orgName: f.prep?.org_id ? orgNames.get(f.prep.org_id) ?? null : null,
      reason: String(f.fields?.notes ?? f.fields?.concerns ?? f.fields?.reason ?? "").trim() || "Reason not recorded", explicit: true, at: f.updated_at, source: "Site-visit feedback" })),
    ...opts.filter((o) => o.option_status === "rejected").map((o) => ({
      requirementId: o.requirement_id, requirementTitle: o.requirement?.title ?? null, orgName: o.requirement?.org_id ? orgNames.get(o.requirement.org_id) ?? null : null,
      reason: (o.disqualifiers ?? []).length ? `Did not fit: ${(o.disqualifiers as string[]).join(", ")}` : "Reason not recorded", explicit: false, at: o.updated_at, source: "Shortlist option" })),
  ];
  const unknowns: string[] = [];
  if (!asset.developer_org_id) unknowns.push("Developer");
  if (!asset.owner_org_id) unknowns.push("Landlord");
  if (!asset.operator_org_id) unknowns.push("Property manager");
  if (!avail.length) unknowns.push("Any availability observation");
  return {
    asset, alternateNames: [...new Set(aliases.map((a) => a.raw_alias).filter((a) => a && a !== asset.name))],
    developer: orgNames.get(asset.developer_org_id) ?? null, landlord: orgNames.get(asset.owner_org_id) ?? null, propertyManager: orgNames.get(asset.operator_org_id) ?? null,
    inventory, availabilityHistory: availItems.reverse(), quotations, latestKnownTerms: quotations[0] ?? null, valueChanges,
    clientInterest: opts.filter((o) => o.requirement).map((o) => ({ requirementId: o.requirement.id, requirementTitle: o.requirement.title, orgId: o.requirement.org_id, orgName: orgNames.get(o.requirement.org_id) ?? null, status: o.option_status ?? "proposed", at: o.updated_at })),
    rejections, relatedRequirements: [...reqTitle].map(([id, title]) => ({ id, title })), specs: asset.specs ?? null, unknowns,
  };
}
