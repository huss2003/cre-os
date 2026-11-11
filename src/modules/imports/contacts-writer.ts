/*
 * Writes contact / requirement sheet rows (adapter contacts_requirements_v1). Spec §3.3–3.4, §5–7, §15.
 *
 *  - Companies: one master per canonical name (legal-suffix variants in one file are one company). Before creating, a
 *    live company with the same canonical name is reused; several candidates => a new company + identity review
 *    candidates (never merged automatically).
 *  - People: created only with a hard identifier (valid email or phone). A person already holding that email/phone is
 *    LINKED, not duplicated; differences against that person become field conflicts / proposals (never overwrites).
 *    Name-only contacts become person-create proposals (existing steward mechanism).
 *  - Requirements are material: always a proposeChange (create, or an update of an applied one when the row changed),
 *    with spreadsheet values as `reported`. Area only becomes area_*_sf when the unit is explicitly sq ft; basis/rent
 *    basis only when stated; a spreadsheet lease expiry is stored as a reported, unconfirmed value in constraints.
 *  - Deterministic ids + idempotency keys => re-running the same file creates nothing.
 */
import "server-only";
import { proposeChange } from "@/lib/services/changes";
import { liveGeographyIndex, pickGeography } from "@/lib/services/geography";
import { canonicalOrg, exactKey } from "./normalize";
import { findCandidates, orgBlock, scoreOrganisation } from "./identity";
import type { ContactRecord } from "./types";
import type { StagedRowDraft } from "./reconcile";
import { hashOf } from "./reconcile";
import {
  type AnyRow, type ConflictDraft, type Ctx, type RepDraft, type Target, chunk, detId, existingIds, insertIgnore, pool, resolveKeys, selectAll,
  selectIn, stamp,
} from "./pipeline";

type Row = StagedRowDraft & { record: ContactRecord };

export interface ContactWriteResult {
  masters: Record<string, { new: number; existing_linked: number }>;
  conflicts: ConflictDraft[];
  reps: RepDraft[];
  summary: {
    rows: number; companies_new: number; companies_linked: number; people_new: number; people_linked: number; contact_methods_new: number;
    employments_new: number; requirement_proposals: number; requirement_update_proposals: number; contact_method_proposals: number;
    employment_proposals: number; company_candidates: number; proposal_failures: number; created_ids: string[]; linked_ids: string[];
  };
  warnings: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

const BUSINESS = ["area_min_sf", "area_max_sf", "area_target_sf", "area_basis", "seats_min", "seats_max", "seats_target", "budget_min", "budget_max", "budget_basis", "preferred_geography_ids"];
const RAW = ["area_raw", "rent_raw", "preferred_location_raw", "current_building_raw"];
/** True when every value the new row reports equals what the latest earlier proposal already said. */
export function subsumed(next: Record<string, unknown>, prevOps: { path: string; value: unknown }[] | null): boolean {
  if (!Array.isArray(prevOps)) return false;
  const prev = Object.fromEntries(prevOps.map((o) => [o.path.slice(1), o.value]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const k of BUSINESS) if (next[k] !== undefined && next[k] !== null && !same(next[k], prev[k])) return false;
  const nc = (next.constraints ?? {}) as Record<string, unknown>, pc = (prev.constraints ?? {}) as Record<string, unknown>;
  for (const k of RAW) if (nc[k] !== null && nc[k] !== undefined && !same(nc[k], pc[k])) return false;
  const ne = nc.lease_expiry_reported as { raw?: unknown } | null, pe = pc.lease_expiry_reported as { raw?: unknown } | null;
  if (ne?.raw && !same(ne.raw, pe?.raw)) return false;
  return true;
}

export async function writeContacts(ctx: Ctx, staged: StagedRowDraft[], addT: (loc: string, t: Target) => void): Promise<ContactWriteResult> {
  const rows = staged.filter((r) => (r.status === "accepted" || r.status === "duplicate") && r.record?.kind === "contact_row") as Row[];
  const s: ContactWriteResult["summary"] = {
    rows: rows.length, companies_new: 0, companies_linked: 0, people_new: 0, people_linked: 0, contact_methods_new: 0, employments_new: 0,
    requirement_proposals: 0, requirement_update_proposals: 0, contact_method_proposals: 0, employment_proposals: 0, company_candidates: 0,
    proposal_failures: 0, created_ids: [], linked_ids: [],
  };
  const out: ContactWriteResult = { masters: {}, conflicts: [], reps: [], summary: s, warnings: [] };
  if (!rows.length) return out;
  const stagedId = (r: StagedRowDraft) => detId(ctx.ws, "staged_row", `${ctx.batchId}|${r.sheet}|${r.row_number}`);
  const propose = async (label: string, input: Parameters<typeof proposeChange>[2]) => {
    try { return await proposeChange(ctx.db, ctx.ws, { proposedByKind: "job", classification: ctx.classification, ownerUserId: ctx.owner, actorUserId: ctx.actor, ...input }); }
    catch (e) { s.proposal_failures++; out.warnings.push(`${label}: ${(e as Error).message}`); return null; }
  };

  /* ---------------- companies */
  const orgNames = new Map<string, string>();
  for (const r of rows) if (r.record.company_key && !orgNames.has(`canon:${r.record.company_key}`)) orgNames.set(`canon:${r.record.company_key}`, r.record.company!);
  const orgRes = await resolveKeys(ctx, "organisation", [...orgNames.keys()]);
  const livePool = (await selectAll<{ id: string; display_name: string; legal_name: string | null; cin: string | null; gstin: string | null; domain: string | null }>(
    ctx.db, ctx.ws, "organisation", "id, display_name, legal_name, cin, gstin, domain", { isNull: ["archived_at"] }));
  const present = await existingIds(ctx, "organisation", [...orgRes.values()].map((r) => r.id));
  const byCanon = new Map<string, typeof livePool>();
  for (const o of livePool) {
    for (const n of new Set([canonicalOrg(o.display_name), o.legal_name ? canonicalOrg(o.legal_name) : ""])) {
      if (n) (byCanon.get(n) ?? byCanon.set(n, []).get(n)!).push(o);
    }
  }
  const reviewPairs: { left: string; right: string; name: string; other: string }[] = [];
  for (const [k, r] of orgRes) {
    if (present.has(r.id)) continue;
    const hits = (byCanon.get(k.slice(6)) ?? []).filter((o) => o.id !== r.id);
    if (hits.length === 1) {
      r.id = hits[0].id; r.created = false;
      const { error } = await ctx.db.from("import_entity_key").update({ entity_id: r.id }).eq("workspace_id", ctx.ws).eq("id", detId(ctx.ws, "key:organisation", k));
      if (error) throw error;
    } else if (hits.length > 1) {
      for (const h of hits) reviewPairs.push({ left: r.id, right: h.id, name: orgNames.get(k)!, other: h.display_name });
    }
  }
  const newOrgs = [...orgRes].filter(([, r]) => r.created && !present.has(r.id));
  await insertIgnore(ctx.db, "organisation", newOrgs.map(([k, r]) => stamp(ctx, { id: r.id, display_name: orgNames.get(k), source_confidence: "import_name_only" })));
  // fuzzy candidates for the new companies (similar, not identical, names) — review queue only
  const candRows: Record<string, unknown>[] = [];
  const thePool = livePool.map((o) => ({ id: o.id, name: o.display_name, legal_name: o.legal_name, cin: o.cin, gstin: o.gstin, domain: o.domain }));
  const fresh = newOrgs.map(([k, r]) => ({ id: r.id, name: orgNames.get(k)!, legal_name: null, cin: null, gstin: null, domain: null }));
  for (const c of findCandidates(fresh, [...thePool, ...fresh], scoreOrganisation, (x) => orgBlock(x.name), ctx.thresholds)) {
    candRows.push(stamp(ctx, {
      id: detId(ctx.ws, "identity_match_candidate", `organisation|${[c.left.id, c.right.id].sort().join("|")}`), batch_id: ctx.batchId, entity_type: "organisation",
      left_id: c.left.id, right_id: c.right.id, right_raw: { name: c.right.name, left_name: c.left.name }, score: c.score.score,
      evidence: { ...c.score.evidence, hard_agree: c.score.hardAgree, decision_band: c.decision }, suggested: c.score.suggested, decision: "pending",
    }));
  }
  for (const p of reviewPairs) {
    candRows.push(stamp(ctx, {
      id: detId(ctx.ws, "identity_match_candidate", `organisation|${[p.left, p.right].sort().join("|")}`), batch_id: ctx.batchId, entity_type: "organisation",
      left_id: p.left, right_id: p.right, right_raw: { name: p.other, left_name: p.name }, score: 0.9,
      evidence: { reason: "same canonical name as several existing companies", decision_band: "review" }, suggested: "review", decision: "pending",
    }));
  }
  const candMap = new Map(candRows.map((c) => [c.id as string, c]));
  await insertIgnore(ctx.db, "identity_match_candidate", [...candMap.values()]);
  s.company_candidates = candMap.size;
  const orgOf = (r: Row) => (r.record.company_key ? orgRes.get(`canon:${r.record.company_key}`) ?? null : null);

  /* ---------------- people (hard identifier only) */
  const withId = rows.filter((r) => r.record.contact_name && (r.record.emails.length || r.record.phones.length));
  const values = [...new Set(withId.flatMap((r) => [...r.record.emails, ...r.record.phones]))];
  const cmHits = await selectIn<{ person_id: string; value: string; method_type: string }>(ctx.db, ctx.ws, "contact_method", "value", values, "person_id, value, method_type");
  const livePeople = new Map((await selectIn<{ id: string; full_name: string; row_version: number; archived_at: string | null }>(
    ctx.db, ctx.ws, "person", "id", [...new Set(cmHits.map((c) => c.person_id))], "id, full_name, row_version, archived_at")).filter((p) => !p.archived_at).map((p) => [p.id, p]));
  const personByValue = new Map<string, string>();
  for (const c of cmHits) if (livePeople.has(c.person_id) && !personByValue.has(c.value)) personByValue.set(c.value, c.person_id);
  const needKeys = withId.filter((r) => ![...r.record.emails, ...r.record.phones].some((v) => personByValue.has(v))).map((r) => r.record.identity_key);
  const personRes = await resolveKeys(ctx, "person", needKeys);
  const presentPeople = await existingIds(ctx, "person", [...personRes.values()].map((r) => r.id));
  const personOf = (r: Row): { id: string; created: boolean } | null => {
    if (!r.record.contact_name || !(r.record.emails.length || r.record.phones.length)) return null;
    const hit = [...r.record.emails, ...r.record.phones].map((v) => personByValue.get(v)).find(Boolean);
    if (hit) return { id: hit, created: false };
    const k = personRes.get(r.record.identity_key);
    return k ? { id: k.id, created: k.created && !presentPeople.has(k.id) } : null;
  };

  const personRows = new Map<string, Record<string, unknown>>();
  const cmRows = new Map<string, Record<string, unknown>>();
  const empRows = new Map<string, Record<string, unknown>>();
  const existingPersonIds = new Set<string>();
  for (const r of withId) {
    const p = personOf(r)!;
    if (!p.created) { existingPersonIds.add(p.id); continue; }
    if (!personRows.has(p.id)) personRows.set(p.id, stamp(ctx, { id: p.id, full_name: r.record.contact_name }));
    const methods: [string, string][] = [...r.record.emails.map((v) => ["email", v] as [string, string]), ...r.record.phones.map((v) => ["phone", v] as [string, string])];
    for (const [t, v] of methods) {
      const id = detId(ctx.ws, "contact_method", `${p.id}|${t}|${v}`);
      if (!cmRows.has(id)) cmRows.set(id, stamp(ctx, { id, person_id: p.id, method_type: t, value: v, verify_status: "unverified", source_name: `import ${ctx.sourceVersion} ${r.record.cell_refs[t] ?? r.locator}`, observed_on: today() }));
    }
    const org = orgOf(r);
    if (org) {
      const id = detId(ctx.ws, "employment", `${p.id}|${org.id}`);
      if (!empRows.has(id)) empRows.set(id, stamp(ctx, { id, person_id: p.id, org_id: org.id, title: r.record.designation, is_current: true, fact_status: "reported", source_object_id: ctx.src }));
    }
  }
  const presentCm = await existingIds(ctx, "contact_method", [...cmRows.keys()]);
  const presentEmp = await existingIds(ctx, "employment", [...empRows.keys()]);
  await insertIgnore(ctx.db, "person", [...personRows.values()]);
  await insertIgnore(ctx.db, "contact_method", [...cmRows.values()].filter((x) => !presentCm.has(x.id as string)));
  await insertIgnore(ctx.db, "employment", [...empRows.values()].filter((x) => !presentEmp.has(x.id as string)));
  s.contact_methods_new = [...cmRows.keys()].filter((k) => !presentCm.has(k)).length;
  s.employments_new = [...empRows.keys()].filter((k) => !presentEmp.has(k)).length;

  /* ---------------- existing people: differences become conflicts / proposals, never overwrites */
  if (existingPersonIds.size) {
    const methods = await selectIn<{ person_id: string; value: string }>(ctx.db, ctx.ws, "contact_method", "person_id", [...existingPersonIds], "person_id, value");
    const have = new Set(methods.map((m) => `${m.person_id}|${m.value}`));
    const emps = await selectIn<{ person_id: string; org_id: string; is_current: boolean | null; archived_at: string | null }>(ctx.db, ctx.ws, "employment", "person_id", [...existingPersonIds], "person_id, org_id, is_current, archived_at");
    const empHave = new Set(emps.filter((e) => !e.archived_at).map((e) => `${e.person_id}|${e.org_id}`));
    const tasks: (() => Promise<void>)[] = [];
    const seen = new Set<string>();
    for (const r of withId) {
      if (r.status === "duplicate") continue;
      const p = personOf(r)!;
      if (p.created) continue;
      const cur = livePeople.get(p.id);
      if (cur && exactKey(cur.full_name) !== exactKey(r.record.contact_name)) {
        out.conflicts.push({ entity_type: "person", entity_id: p.id, label: cur.full_name, field: "full_name", master_value: cur.full_name, source_value: r.record.contact_name, row_version: Number(cur.row_version), r });
      }
      const methods2: [string, string][] = [...r.record.emails.map((v) => ["email", v] as [string, string]), ...r.record.phones.map((v) => ["phone", v] as [string, string])];
      for (const [t, v] of methods2) {
        if (have.has(`${p.id}|${v}`) || seen.has(`${p.id}|${v}`)) continue;
        seen.add(`${p.id}|${v}`);
        tasks.push(async () => {
          const res = await propose(`contact ${v}`, {
            targetType: "contact_method", operation: "create",
            patch: [{ op: "add", path: "/person_id", value: p.id }, { op: "add", path: "/method_type", value: t }, { op: "add", path: "/value", value: v },
              { op: "add", path: "/verify_status", value: "unverified" }, { op: "add", path: "/source_name", value: `import ${ctx.sourceVersion} ${r.record.cell_refs[t] ?? r.locator}` }],
            reason: `Import ${ctx.sourceVersion} ${r.locator}: ${r.record.contact_name} also listed with ${t} ${v} (not on the existing record).`,
            evidenceIds: [stagedId(r), ctx.src], idempotencyKey: `imports.contact_method:${p.id}|${v}`,
          });
          if (res) s.contact_method_proposals++;
        });
      }
      const org = orgOf(r);
      if (org && !empHave.has(`${p.id}|${org.id}`) && !seen.has(`emp|${p.id}|${org.id}`)) {
        seen.add(`emp|${p.id}|${org.id}`);
        tasks.push(async () => {
          const res = await propose(`employment ${r.record.contact_name}`, {
            targetType: "employment", operation: "create",
            patch: [{ op: "add", path: "/person_id", value: p.id }, { op: "add", path: "/org_id", value: org.id }, { op: "add", path: "/title", value: r.record.designation },
              { op: "add", path: "/is_current", value: true }, { op: "add", path: "/fact_status", value: "reported" }],
            reason: `Import ${ctx.sourceVersion} ${r.locator}: ${r.record.contact_name} is listed at ${r.record.company}, which is not on their record — possible employer change. Approve to add the employment (the old one is not closed automatically).`,
            evidenceIds: [stagedId(r), ctx.src], idempotencyKey: `imports.employment:${p.id}|${org.id}`,
          });
          if (res) s.employment_proposals++;
        });
      }
    }
    await pool(tasks, 6, (t) => t());
  }

  /* ---------------- name-only contacts: person proposals via the steward */
  for (const r of rows) {
    if (r.status === "duplicate" || !r.record.contact_name || r.record.emails.length || r.record.phones.length) continue;
    const org = orgOf(r);
    if (org) out.reps.push({ name: r.record.contact_name, org_id: org.id, org_name: r.record.company!, r });
  }

  /* ---------------- requirements (material: proposals only) */
  const reqRows = rows.filter((r) => r.status !== "duplicate" && orgOf(r) && (r.record.area?.min || r.record.rent?.min || r.record.location || r.record.lease_expiry));
  if (reqRows.length) {
    const geoIdx = await liveGeographyIndex(ctx.db, ctx.ws);
    const drafts = reqRows.map((r) => {
      const rec = r.record;
      const org = orgOf(r)!;
      const patch: Record<string, unknown> = { org_id: org.id, title: `${rec.company} — requirement (spreadsheet)`, status: "estimated" };
      const a = rec.area;
      if (a?.min && a.unit === "sq_ft") {
        if (a.min === a.max) patch.area_target_sf = a.min; else { patch.area_min_sf = a.min; patch.area_max_sf = a.max; }
      }
      if (a?.min && a.unit === "seats") { if (a.min === a.max) patch.seats_target = Math.round(a.min); else { patch.seats_min = Math.round(a.min); patch.seats_max = Math.round(a.max!); } }
      if (a?.basis && a.unit === "sq_ft") patch.area_basis = a.basis;
      if (rec.rent?.min && rec.rent.basis) { patch.budget_min = rec.rent.min; patch.budget_max = rec.rent.max; patch.budget_basis = rec.rent.basis; }
      const geo = rec.location ? pickGeography(geoIdx, rec.location) : null;
      if (geo) patch.preferred_geography_ids = [geo.id];
      const valuesHash = hashOf(patch).slice(0, 12) + hashOf([a, rec.rent, rec.location, rec.lease_expiry]).slice(0, 8);
      patch.constraints = {
        source: "spreadsheet_import", fact_status: "reported", source_label: ctx.sourceVersion, locator: r.locator, cell_refs: rec.cell_refs,
        area_raw: a?.raw ?? null, area_unit: a?.unit ?? null, area_basis: a?.basis ?? null, rent_raw: rec.rent?.raw ?? null, rent_basis: rec.rent?.basis ?? null,
        preferred_location_raw: rec.location, current_building_raw: rec.current_building,
        // a spreadsheet date is never a confirmed contractual date (§15 rule 5)
        lease_expiry_reported: rec.lease_expiry ? { ...rec.lease_expiry, confirmed: false } : null,
      };
      const ident = detId(ctx.ws, "import_requirement", `${org.id}|${rec.identity_key}`);
      return { r, org, patch, ident, key: `imports.requirement:${ident}:${valuesHash}` };
    });
    const prior = new Map<string, AnyRow[]>();
    for (const part of chunk([...new Set(drafts.map((d) => d.ident))], 40)) {
      const { data, error } = await ctx.db.from("change_proposal").select("id, idempotency_key, state, target_id, created_at, patch").eq("workspace_id", ctx.ws)
        .or(part.map((i) => `idempotency_key.like."imports.requirement:${i}:*"`).join(","));
      if (error) throw new Error(`change_proposal lookup failed: ${error.message}`);
      for (const p of data ?? []) { const i = String(p.idempotency_key).split(":")[1]; (prior.get(i) ?? prior.set(i, []).get(i)!).push(p); }
    }
    const reqIds = [...new Set([...prior.values()].flat().filter((p) => p.state === "applied" && p.target_id).map((p) => p.target_id as string))];
    const reqs = new Map((await selectIn<AnyRow>(ctx.db, ctx.ws, "requirement", "id", reqIds, "*")).map((x) => [x.id as string, x]));
    const done = new Set<string>();
    await pool(drafts, 6, async (d) => {
      if (done.has(d.key)) return;
      done.add(d.key);
      const earlier = prior.get(d.ident) ?? [];
      addT(d.r.locator, { type: "requirement_proposal", id: d.ident, role: "observation", created: !earlier.length });
      if (earlier.some((p) => p.idempotency_key === d.key)) return; // same values already proposed => no-op
      // a column missing from the new layout means "not reported", not "cleared": nothing new => no proposal
      const latest = [...earlier].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (latest && subsumed(d.patch, latest.patch)) return;
      const applied = earlier.filter((p) => p.state === "applied" && p.target_id && reqs.has(p.target_id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (applied) {
        const cur = reqs.get(applied.target_id)!;
        const ops = Object.entries(d.patch).filter(([k, v]) => !["title", "status", "org_id", "constraints"].includes(k) && JSON.stringify(v) !== JSON.stringify(cur[k]))
          .map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v }));
        if (!ops.length) return;
        ops.push({ op: "replace", path: "/constraints", value: { ...((cur.constraints ?? {}) as object), ...(d.patch.constraints as object) } });
        const res = await propose(`requirement update ${d.r.record.company}`, {
          targetType: "requirement", targetId: cur.id, operation: "update", expectedVersion: Number(cur.row_version), patch: ops,
          reason: `Updated spreadsheet ${ctx.sourceVersion} ${d.r.locator} changes ${ops.map((o) => o.path.slice(1)).join(", ")} for ${d.r.record.company}. Previous values stay in the change history.`,
          evidenceIds: [stagedId(d.r), ctx.src], idempotencyKey: d.key,
        });
        if (res) s.requirement_update_proposals++;
        return;
      }
      const res = await propose(`requirement ${d.r.record.company}`, {
        targetType: "requirement", operation: "create", patch: Object.entries(d.patch).map(([k, v]) => ({ op: "add" as const, path: `/${k}`, value: v })),
        reason: `Spreadsheet ${ctx.sourceVersion} ${d.r.locator}: ${d.r.record.company} requirement (reported, not client-confirmed)` +
          (earlier.length ? `; values changed since an earlier upload (earlier proposal kept for history)` : "") +
          (d.r.record.area?.min && !d.r.record.area.unit ? `; area ${d.r.record.area.raw} has no unit, so it is kept raw only` : "") +
          (d.r.record.lease_expiry ? `; lease expiry ${d.r.record.lease_expiry.raw} is a reported date, not a confirmed contractual date` : ""),
        evidenceIds: [stagedId(d.r), ctx.src], idempotencyKey: d.key,
      });
      if (res) s.requirement_proposals++;
    });
  }

  /* ---------------- targets + counts */
  const masterSeen = new Map<string, boolean>();
  for (const r of rows) {
    const org = orgOf(r);
    if (org) { addT(r.locator, { type: "organisation", id: org.id, role: "master", created: org.created }); masterSeen.set(`organisation|${org.id}`, org.created); }
    const p = personOf(r);
    if (p) { addT(r.locator, { type: "person", id: p.id, role: "master", created: p.created }); masterSeen.set(`person|${p.id}`, p.created); }
  }
  for (const [k, created] of masterSeen) {
    const [type, id] = k.split("|");
    const m = (out.masters[type] ??= { new: 0, existing_linked: 0 });
    if (created) { m.new++; s.created_ids.push(`${type}:${id}`); } else { m.existing_linked++; s.linked_ids.push(`${type}:${id}`); }
  }
  s.companies_new = out.masters.organisation?.new ?? 0;
  s.companies_linked = out.masters.organisation?.existing_linked ?? 0;
  s.people_new = out.masters.person?.new ?? 0;
  s.people_linked = out.masters.person?.existing_linked ?? 0;
  s.created_ids = s.created_ids.slice(0, 500);
  s.linked_ids = s.linked_ids.slice(0, 500);
  return out;
}
