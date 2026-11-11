import "server-only";
/** Intelligence timeline (spec §4.3, §14E): chronological, filterable, every event source-linked. Read-only, RLS. */
import { commitmentsFrom, interactionSource, objectionsFrom, q } from "../data";
import { requirementEvolution, type VersionRow } from "../requirement/confidence";
import { hrefFor, verificationOf, type MemCtx, type Row, type TimelineEvent, type TimelineEventType, type TimelineFilters } from "../types";

const LIM = 200;
const fmt = (v: unknown) => (v === null || v === undefined || (Array.isArray(v) && v.every((x) => x == null)) ? "unknown" : Array.isArray(v) ? v.map((x) => x ?? "?").join("–") : String(v));

export async function getTimeline(ctx: MemCtx, f: TimelineFilters = {}): Promise<TimelineEvent[]> {
  const ws = ctx.workspaceId;
  const want = (t: TimelineEventType) => !f.types?.length || f.types.includes(t);
  const scoped = !!(f.orgId || f.personId || f.assetId || f.requirementId || f.opportunityId);
  // Resolve scope: a company brings its requirements and opportunities.
  const reqIds = new Set<string>(f.requirementId ? [f.requirementId] : []);
  const oppIds = new Set<string>(f.opportunityId ? [f.opportunityId] : []);
  if (f.orgId) {
    for (const r of await q(ctx.db.from("requirement").select("id").eq("workspace_id", ws).eq("org_id", f.orgId).is("archived_at", null).limit(100))) reqIds.add(r.id);
    for (const o of await q(ctx.db.from("opportunity").select("id").eq("workspace_id", ws).eq("org_id", f.orgId).is("archived_at", null).limit(100))) oppIds.add(o.id);
  }
  if (f.opportunityId) {
    const { data: o } = await ctx.db.from("opportunity").select("requirement_id").eq("workspace_id", ws).eq("id", f.opportunityId).maybeSingle();
    if (o?.requirement_id && !f.requirementId && !f.orgId) reqIds.add(o.requirement_id);
  }
  const out: TimelineEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const range = (b: any, col: string): any => { let x = b; if (f.from) x = x.gte(col, f.from); if (f.to) x = x.lte(col, `${f.to}T23:59:59Z`); return x; };

  // Interactions (+ commitments, objections)
  if (want("interaction") || want("commitment") || want("objection")) {
    const pairs: [string, string[]][] = scoped
      ? [["person", f.personId ? [f.personId] : []], ["organisation", f.orgId ? [f.orgId] : []], ["asset", f.assetId ? [f.assetId] : []], ["requirement", [...reqIds]], ["opportunity", [...oppIds]]]
      : [];
    let ints: Row[] = [];
    const cols = "id, occurred_at, channel, direction, subject, summary, promises, objections, capture_id, is_meaningful";
    if (scoped) {
      const by = new Map<string, Row>();
      for (const [t, ids] of pairs) if (ids.length) {
        const ls = await q(range(ctx.db.from("interaction_link").select(`interaction:interaction_id!inner(${cols})`).eq("workspace_id", ws).eq("entity_type", t).in("entity_id", ids).is("archived_at", null), "interaction.occurred_at").limit(LIM));
        for (const l of ls) if (l.interaction) by.set(l.interaction.id, l.interaction);
      }
      ints = [...by.values()];
    } else ints = await q(range(ctx.db.from("interaction").select(cols).eq("workspace_id", ws).is("archived_at", null), "occurred_at").order("occurred_at", { ascending: false }).limit(LIM));
    for (const i of ints) {
      const src = interactionSource(i);
      if (want("interaction")) out.push({ id: `i:${i.id}`, at: i.occurred_at, type: "interaction", title: `${i.channel ?? "Note"}${i.direction ? ` (${i.direction})` : ""}: ${i.subject ?? "no subject"}`, detail: i.summary ?? null, refs: [], sourceRef: src, verification: "reported" });
      if (want("commitment")) for (const c of commitmentsFrom([i])) out.push({ id: `c:${i.id}:${c.text}`, at: i.occurred_at, type: "commitment", title: `Commitment: ${c.text}`, detail: `${c.pending ? (c.overdue ? "Overdue" : "Pending") : "Done"}${c.due ? ` · due ${c.due}` : ""}`, refs: [], sourceRef: src, verification: "reported" });
      if (want("objection")) for (const o of objectionsFrom([i])) out.push({ id: `o:${i.id}:${o.text}`, at: i.occurred_at, type: "objection", title: `Objection: ${o.text}`, detail: null, refs: [], sourceRef: src, verification: "reported" });
    }
  }
  // Meetings
  if (want("meeting")) {
    let b = ctx.db.from("meeting_visit").select("id, title, start_at, status, kind, linked_entity_type, linked_entity_id, opportunity_id").eq("workspace_id", ws).is("archived_at", null);
    const ors: string[] = [];
    if (f.personId) ors.push(`and(linked_entity_type.eq.person,linked_entity_id.eq.${f.personId})`);
    if (f.orgId) ors.push(`and(linked_entity_type.eq.organisation,linked_entity_id.eq.${f.orgId})`);
    if (oppIds.size) ors.push(`opportunity_id.in.(${[...oppIds].join(",")})`);
    if (scoped && !ors.length) b = b.eq("id", "00000000-0000-0000-0000-000000000000");
    else if (ors.length) b = b.or(ors.join(","));
    for (const m of await q(range(b, "start_at").order("start_at", { ascending: false }).limit(LIM)))
      out.push({ id: `m:${m.id}`, at: m.start_at, type: "meeting", title: `${m.kind === "site_visit" ? "Site visit" : "Meeting"}: ${m.title ?? "untitled"}`, detail: m.status ?? null, refs: [], sourceRef: { type: "meeting_visit", id: m.id, label: m.title ?? "Meeting", href: `/meetings/${m.id}` }, verification: "verified" });
  }
  // Employment (job changes)
  if (want("employment") && (!scoped || f.personId || f.orgId)) {
    let b = ctx.db.from("employment").select("id, person_id, org_id, title, start_date, end_date, is_current, fact_status, created_at, person:person_id(full_name), org:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null);
    if (f.personId) b = b.eq("person_id", f.personId); if (f.orgId) b = b.eq("org_id", f.orgId);
    for (const e of await q(range(b, "created_at").order("created_at", { ascending: false }).limit(LIM)))
      out.push({ id: `e:${e.id}`, at: e.start_date ?? e.created_at, type: "employment", title: `${e.person?.full_name ?? "Contact"} — ${e.title ?? "role unknown"} at ${e.org?.display_name ?? "company"}`, detail: e.is_current && !e.end_date ? "Current role" : `Ended ${e.end_date ?? "(date unknown)"}`, refs: [{ type: "person", id: e.person_id }, { type: "organisation", id: e.org_id }], sourceRef: { type: "employment", id: e.id, label: "Employment record", href: hrefFor("person", e.person_id) }, verification: verificationOf(e.fact_status) });
  }
  // Requirement changes
  if (want("requirement_version") && (!scoped || reqIds.size)) {
    let b = ctx.db.from("requirement_version").select("requirement_id, version, snapshot, created_at, change_reason, change_proposal_id").eq("workspace_id", ws);
    if (scoped) b = b.in("requirement_id", [...reqIds]);
    const vs = await q(range(b, "created_at").order("created_at", { ascending: false }).limit(LIM));
    const byReq = new Map<string, Row[]>(); for (const v of vs) byReq.set(v.requirement_id, [...(byReq.get(v.requirement_id) ?? []), v]);
    for (const [rid, list] of byReq) {
      const sorted = [...list].sort((a, b2) => a.version - b2.version);
      const title = String(sorted.at(-1)?.snapshot?.title ?? "Requirement");
      const ev = requirementEvolution(sorted as VersionRow[]);
      for (const v of sorted) {
        const ch = ev.filter((c) => c.toVersion === v.version);
        if (v.version !== sorted[0].version && !ch.length) continue;
        out.push({ id: `rv:${rid}:${v.version}`, at: v.created_at, type: "requirement_version", title: v.version === 1 ? `Requirement recorded: ${title}` : `Requirement changed: ${title}`,
          detail: ch.length ? ch.map((c) => `${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join("; ") + (v.change_reason ? ` (${v.change_reason})` : "") : v.change_reason ?? null,
          refs: [{ type: "requirement", id: rid }], sourceRef: { type: "requirement_version", id: rid, label: `Version ${v.version}`, href: hrefFor("requirement", rid) }, verification: v.change_proposal_id ? "verified" : "estimated" });
      }
    }
  }
  // Deal stages
  if (want("opportunity_stage") && (!scoped || oppIds.size)) {
    let b = ctx.db.from("opportunity_stage_history").select("id, opportunity_id, from_stage, to_stage, changed_at, evidence, opportunity:opportunity_id(name)").eq("workspace_id", ws);
    if (scoped) b = b.in("opportunity_id", [...oppIds]);
    for (const s of await q(range(b, "changed_at").order("changed_at", { ascending: false }).limit(LIM)))
      out.push({ id: `os:${s.id}`, at: s.changed_at, type: "opportunity_stage", title: `${s.opportunity?.name ?? "Deal"}: ${s.from_stage ?? "new"} → ${s.to_stage}`, detail: s.evidence ?? null, refs: [{ type: "opportunity", id: s.opportunity_id }], sourceRef: { type: "opportunity", id: s.opportunity_id, label: s.opportunity?.name ?? "Deal", href: hrefFor("opportunity", s.opportunity_id) }, verification: "verified" });
  }
  // Quotes + availability + rejections (property scope or requirement scope)
  let spaceIds: string[] = [];
  if (f.assetId) spaceIds = (await q(ctx.db.from("space").select("id").eq("workspace_id", ws).eq("asset_id", f.assetId).is("archived_at", null).limit(500))).map((s) => s.id);
  if (want("quote") && (!scoped || spaceIds.length || reqIds.size)) {
    let b = ctx.db.from("quote").select("id, space_id, requirement_id, version, terms_json, offer, kind, created_at, space:space_id(asset_id, asset:asset_id(name))").eq("workspace_id", ws).is("archived_at", null);
    if (f.assetId) b = b.in("space_id", spaceIds.length ? spaceIds : ["00000000-0000-0000-0000-000000000000"]); else if (scoped) b = b.in("requirement_id", [...reqIds]);
    for (const x of await q(range(b, "created_at").order("created_at", { ascending: false }).limit(LIM))) {
      const tj = (x.terms_json ?? x.offer ?? {}) as Row;
      out.push({ id: `q:${x.id}`, at: x.created_at, type: "quote", title: `${x.kind === "landlord_offer" ? "Landlord offer" : "Quotation"}: ${x.space?.asset?.name ?? "building"}`, detail: `Rent ${tj.rent ?? "unknown"} ${tj.rent_basis ?? ""}, CAM ${tj.cam_per_sf ?? "unknown"} (historical — not current pricing)`, refs: x.space?.asset_id ? [{ type: "asset", id: x.space.asset_id }] : [], sourceRef: { type: "quote", id: x.id, label: `Quote v${x.version ?? 1}`, href: x.space?.asset_id ? hrefFor("asset", x.space.asset_id) : null }, verification: "reported" });
    }
  }
  if (want("availability") && f.assetId && spaceIds.length) {
    for (const a of await q(range(ctx.db.from("availability").select("id, space_id, as_of, status, asking_rent_min, cam_psf_month, fact_status, created_at").eq("workspace_id", ws).in("space_id", spaceIds).is("archived_at", null), "as_of").order("as_of", { ascending: false }).limit(LIM)))
      out.push({ id: `a:${a.id}`, at: a.as_of, type: "availability", title: `Availability observed: ${a.status ?? "status unknown"}`, detail: `Rent ${a.asking_rent_min ?? "unknown"}, CAM ${a.cam_psf_month ?? "unknown"} as of ${a.as_of}`, refs: [{ type: "asset", id: f.assetId }], sourceRef: { type: "availability", id: a.id, label: `Snapshot ${a.as_of}`, href: hrefFor("asset", f.assetId) }, verification: verificationOf(a.fact_status) });
  }
  if (want("rejection") && (!scoped || f.assetId || reqIds.size)) {
    let b = ctx.db.from("meeting_property_feedback").select("id, asset_id, fields, updated_at, asset:asset_id(name), prep:prep_id!inner(requirement_id, org_id)").eq("workspace_id", ws).is("archived_at", null).eq("fields->>interest", "rejected");
    if (f.assetId) b = b.eq("asset_id", f.assetId); else if (scoped) b = b.in("prep.requirement_id", [...reqIds]);
    for (const x of await q(range(b, "updated_at").limit(LIM)).catch(() => [] as Row[])) if (x.fields?.explicit_rejection === true)
      out.push({ id: `rj:${x.id}`, at: x.updated_at, type: "rejection", title: `Client rejected ${x.asset?.name ?? "building"}`, detail: String(x.fields?.notes ?? x.fields?.concerns ?? "Reason not recorded"), refs: [{ type: "asset", id: x.asset_id }], sourceRef: { type: "meeting_property_feedback", id: x.id, label: "Site-visit feedback", href: hrefFor("asset", x.asset_id) }, verification: "verified" });
  }
  if (want("signal") && (!scoped || f.orgId)) {
    let b = ctx.db.from("signal").select("id, org_id, title, verification, created_at, event_date").eq("workspace_id", ws).is("archived_at", null).neq("status", "dismissed");
    if (f.orgId) b = b.eq("org_id", f.orgId);
    for (const s of await q(range(b, "created_at").order("created_at", { ascending: false }).limit(LIM)).catch(() => [] as Row[]))
      out.push({ id: `s:${s.id}`, at: s.event_date ?? s.created_at, type: "signal", title: s.title ?? "Business development", detail: s.verification === "fact" ? "Verified" : "Not yet verified", refs: s.org_id ? [{ type: "organisation", id: s.org_id }] : [], sourceRef: { type: "signal", id: s.id, label: "Signal", href: `/signals/${s.id}` }, verification: s.verification === "fact" ? "verified" : "unverified" });
  }
  if (want("relationship_level") && (!scoped || f.personId)) {
    let b = ctx.db.from("contact_relationship_level").select("id, person_id, level, reason, set_at, person:person_id(full_name)").eq("workspace_id", ws).is("archived_at", null);
    if (f.personId) b = b.eq("person_id", f.personId);
    for (const l of await q(range(b, "set_at").order("set_at", { ascending: false }).limit(LIM)))
      out.push({ id: `rl:${l.id}`, at: l.set_at, type: "relationship_level", title: `Relationship with ${l.person?.full_name ?? "contact"} set to ${l.level}`, detail: l.reason ?? null, refs: [{ type: "person", id: l.person_id }], sourceRef: { type: "contact_relationship_level", id: l.id, label: "Relationship level", href: hrefFor("person", l.person_id) }, verification: "reported" });
  }
  const filtered = out.filter((e) => e.at && (!f.from || e.at >= f.from) && (!f.to || e.at.slice(0, 10) <= f.to));
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filtered.slice(0, f.limit ?? 300);
}
