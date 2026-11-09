/**
 * Contact Enrichment service. Workflow per person:
 *   discover (web/AI or records) → identity match → duplicate check → employment check → role/department → channels
 *   (email/phone rules) → field evidence → completeness → USER REVIEW → Module 1 update via change proposals → Module 3 rescore.
 * Nothing reaches canonical records without a person approving it. Verified values are never overwritten silently.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, aiConfigured, AiUnavailableError } from "@/lib/ai/gateway";
import { proposeChange } from "@/lib/services/changes";
import { approveAndApply, proposeMerge, proposePersonMove } from "@/modules/changes/service";
import { scoreEntity } from "@/modules/scoring/service";
import { classify, emailStatus, hasMx, phoneInfo, matchIdentity, completeness, normName, type Existing, type Match } from "./rules";

type Row = Record<string, any>;
export class ContactError extends Error {}
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ sources (adapters + honest availability)

export interface Source { key: string; label: string; kind: string; available: boolean; note: string }
export function sources(): Source[] {
  const ai = aiConfigured();
  return [
    { key: "records", label: "Your records", kind: "Internal", available: true, note: "People, roles, emails and interactions already in the database." },
    { key: "web", label: "Company websites, leadership pages & press releases", kind: "Web search (Claude)", available: ai, note: ai ? "Searches public company pages. LinkedIn is excluded." : "Add ANTHROPIC_API_KEY to switch on." },
    { key: "mca", label: "Company filings (MCA directors)", kind: "Public filings via web search", available: ai, note: ai ? "Directors listed in public MCA data are found during Find people." : "Needs ANTHROPIC_API_KEY." },
    { key: "events", label: "Conference speakers & industry associations", kind: "Public pages via web search", available: ai, note: "CII, NASSCOM, CoreNet and event speaker lists are searched during Find people." },
    { key: "appointments", label: "Appointment news", kind: "News via web search", available: ai, note: "\"X joins Y as Head of Admin\" — finds new decision-makers and job changes. Weekly, or press Scan appointment news." },
    { key: "linkedin_export", label: "Your LinkedIn connections (export)", kind: "Your own file", available: true, note: "Upload Connections.csv from LinkedIn's 'Get a copy of your data'. Free; your own data." },
    { key: "upload", label: "Spreadsheet upload", kind: "File", available: true, note: "Use Setup → Imports; imported people appear here for enrichment." },
    { key: "capture", label: "Business cards & notes", kind: "Capture", available: true, note: "People mentioned in captures become contacts after review." },
    { key: "mx", label: "Email domain check (MX)", kind: "DNS", available: true, note: "Checks the domain accepts mail. Does not prove a mailbox exists." },
    { key: "licensed_b2b", label: "Licensed B2B contact database", kind: "Paid provider", available: false, note: "Not connected — needs a licensed provider account and API key." },
    { key: "linkedin", label: "LinkedIn search / profiles", kind: "Professional network", available: false, note: "No approved integration. Never scraped — use your connections export instead." },
  ];
}

// ------------------------------------------------------------------ helpers

async function existingPeople(db: Db, ws: string, names: string[], emails: string[]): Promise<Existing[]> {
  const ns = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const ids = new Set<string>();
  for (const n of ns) {
    const first = normName(n).split(" ")[0];
    const { data } = await db.from("person").select("id").eq("workspace_id", ws).is("archived_at", null).ilike("full_name", `%${first}%`).limit(50);
    (data ?? []).forEach((r) => ids.add(r.id));
  }
  if (emails.length) {
    const { data } = await db.from("contact_method").select("person_id").eq("workspace_id", ws).in("value", emails).is("archived_at", null);
    (data ?? []).forEach((r) => ids.add(r.person_id));
  }
  if (!ids.size) return [];
  const { data } = await db.from("person").select("id, full_name, aliases, public_profile_url, contact_method(value, method_type), employment(org_id, is_current, archived_at)").eq("workspace_id", ws).in("id", [...ids]);
  return (data ?? []).map((p: Row) => ({
    id: p.id, full_name: p.full_name, aliases: p.aliases ?? [], profile: p.public_profile_url,
    emails: (p.contact_method ?? []).filter((m: Row) => m.method_type === "email").map((m: Row) => m.value),
    current_org_ids: (p.employment ?? []).filter((e: Row) => e.is_current && !e.archived_at).map((e: Row) => e.org_id),
    past_org_ids: (p.employment ?? []).filter((e: Row) => !e.is_current).map((e: Row) => e.org_id),
  }));
}

const STAGE_FOR: Record<Match["kind"], string> = { new: "verification_required", existing: "verification_required", possible_duplicate: "possible_duplicate", job_change: "employment_verification_pending" };

export const SOURCE_TYPES: Record<string, string> = {
  company_site: "Company website / leadership page", press: "Company press release", news: "News article", regulatory_filing: "Company filing (MCA directors)",
  conference: "Conference speaker list", association: "Industry association page", appointment_news: "Appointment news", linkedin_export: "Your LinkedIn export", records: "Your records",
};
const stype = (t: string | null | undefined) => (t && t in SOURCE_TYPES ? t : "news");
interface Found { source_type?: string | null; company_raw?: string | null; full_name: string; title: string | null; location: string | null; emails: string[]; phones: string[]; phone_is_mobile?: boolean; profile: string | null; source_url: string | null; source_name: string; published_on: string | null; responsibilities?: string | null }

/** Turns one found person into a reviewable item with field-level evidence. */
async function buildItem(db: Db, ws: string, jobId: string, orgIn: Row | null, f: Found, people: Existing[], method: string) {
  const org: Row = orgIn ?? { id: null, display_name: f.company_raw ?? null, domain: null };
  const m = matchIdentity({ full_name: f.full_name, emails: f.emails, profile: f.profile, org_id: org.id }, people);
  const cls = classify(f.title);
  const src = { source_name: f.source_name, source_url: f.source_url, observed_on: f.published_on ?? today(), method };
  const fields: Row[] = [
    { field: "full_name", value: f.full_name, status: method === "linkedin_export" ? "user_provided" : f.source_url ? "reported" : "user_provided", ...src },
    { field: "employer", value: org.display_name, status: org.display_name ? (method === "linkedin_export" ? "user_provided" : "reported") : "missing", ...src, note: orgIn ? undefined : org.display_name ? "Company not in your records yet — it will be added when you approve." : undefined },
    { field: "designation", value: f.title, status: f.title ? "reported" : "missing", ...src },
    { field: "department", value: cls.department, status: cls.department ? "inferred" : "unknown", ...src, method: "rules" },
    { field: "location", value: f.location, status: f.location ? "reported" : "missing", ...src },
    { field: "profile", value: f.profile, status: f.profile ? "reported" : "missing", ...src },
  ];
  for (const e of f.emails.slice(0, 3)) {
    const domain = e.split("@")[1] ?? "";
    const mx = domain ? await hasMx(domain) : null;
    const es = emailStatus({ email: e, companyDomain: org.domain, mx, published: !!f.source_url });
    fields.push({ field: "email", value: e.toLowerCase(), status: es.status, evidence: es.evidence, ...src });
  }
  if (!f.emails.length) fields.push({ field: "email", value: null, status: "missing", ...src, note: "No business email published on the sources checked. Not guessed." });
  for (const p of f.phones.slice(0, 2)) {
    const pi = phoneInfo(p, { published: !!f.source_url, mobileExplicit: f.phone_is_mobile });
    fields.push({ field: "phone", value: pi.e164 ?? p, display: pi.display, status: pi.status, note: pi.note, country: pi.country, ...src });
  }
  if (!f.phones.length) fields.push({ field: "phone", value: null, status: "missing", ...src });
  fields.push({ field: "cre_role", value: cls.role, status: "inferred", note: cls.reason, ...src, method: "rules" });
  const row = {
    workspace_id: ws, job_id: jobId, org_id: org.id, person_id: m.person_id, full_name: f.full_name.slice(0, 160),
    stage: STAGE_FOR[m.kind], match_kind: m.kind, match_reason: m.reason, match_candidates: m.candidates, fields,
    role_class: cls.role, department: cls.department, cre_relevance: cls.relevance, role_reason: cls.reason,
    company_raw: orgIn ? null : f.company_raw ?? null, source_type: method === "linkedin_export" ? "linkedin_export" : stype(f.source_type),
    completeness: completeness(fields as never), dedupe_key: `${normName(f.full_name)}|${(f.title ?? "").toLowerCase()}`,
  };
  const { data, error } = await db.from("enrichment_item").upsert(row, { onConflict: "workspace_id,job_id,dedupe_key", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) throw new ContactError(error.message);
  return data?.id as string | undefined;
}

// ------------------------------------------------------------------ discovery & enrichment (AI web search: extract only, cite everything)

const Found = z.object({
  people: z.array(z.object({
    full_name: z.string(), title: z.string().nullable(), location: z.string().nullable(),
    emails_published: z.array(z.string()), phones_published: z.array(z.string()), phone_is_mobile: z.boolean().nullable(),
    profile_url: z.string().nullable(), source_url: z.string(), source_name: z.string(), published_on: z.string().nullable(), responsibilities: z.string().nullable(),
    source_type: z.string().nullable().optional(), company: z.string().nullable().optional(),
  })),
  company_contact: z.object({ switchboard: z.string().nullable(), contact_page_url: z.string().nullable() }).nullable(),
  suggested_roles: z.array(z.string()),
});

const TARGET_ROLES = "Corporate Real Estate, Workplace Strategy, Facilities, Administration, Infrastructure, Procurement/Sourcing, CFO/Finance Director/Controller, CHRO/HR Head, Managing Director/CEO/COO, Country/India/GCC/Site Head";

async function startJob(db: Db, ws: string, kind: string, label: string, orgId: string | null, userId: string | undefined, key: string | null, srcs: string[]) {
  if (key) {
    const { data: prev } = await db.from("enrichment_job").select("id, status").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (prev && prev.status !== "failed") return { id: prev.id as string, reused: true };
    if (prev) { await db.from("enrichment_job").update({ status: "running", error: null, started_at: new Date().toISOString() }).eq("id", prev.id); return { id: prev.id as string, reused: false }; }
  }
  const { data, error } = await db.from("enrichment_job").insert({ workspace_id: ws, kind, label, org_id: orgId, status: "running", sources: srcs, idempotency_key: key, started_at: new Date().toISOString(), owner_user_id: userId ?? undefined }).select("id").single();
  if (error) throw new ContactError(error.message);
  return { id: data.id as string, reused: false };
}

/** B. Company research: find the relevant people at one company. Idempotent per company per day (use force to rerun). */
export async function discoverCompany(db: Db, ws: string, orgId: string, opts: { userId?: string; force?: boolean; ai?: typeof callStructured } = {}) {
  const ai = opts.ai ?? callStructured;
  const { data: org } = await db.from("organisation").select("id, display_name, domain, sector").eq("workspace_id", ws).eq("id", orgId).maybeSingle();
  if (!org) throw new ContactError("Company not found.");
  const job = await startJob(db, ws, "company_discovery", `Find people at ${org.display_name}`, orgId, opts.userId, opts.force ? null : `discover:${orgId}:${today()}`, ["web", "records"]);
  if (job.reused) return { jobId: job.id, reused: true };
  try {
    const r = await ai({
      workspaceId: ws, workflow: "contacts.discover", tier: "luna", webSearch: true, classification: "public", schema: Found, schemaName: "people_found", maxOutputTokens: 1800,
      system: "You find professionals at one company for a commercial real-estate adviser in India, using only free public sources: the company's own website (leadership/team/contact pages), its press releases, reputable news, public company filings (MCA director lists, including sites that republish MCA data), conference speaker lists, and industry association pages (CII, NASSCOM, CoreNet, etc.). Report only people and details stated in a source you found, each with its URL and source_type (company_site, press, news, regulatory_filing, conference, association, appointment_news). Emails and phone numbers ONLY if explicitly published for that person — never guess or construct an email. Never use LinkedIn. If unsure, leave fields null.",
      input: `Company: ${org.display_name}${org.domain ? ` (website ${org.domain})` : ""}${org.sector ? `, ${org.sector}` : ""}. Focus on India / Pune.\nFind people in these roles: ${TARGET_ROLES}. Also check: Indian directors listed in MCA filings, recent appointment news ("joins as", "appointed"), and conference/association speaker pages. Up to 12 people. Also return the company's published switchboard number and contact page, and up to 3 suggested roles still worth researching.`,
      mock: () => ({ people: [], company_contact: null, suggested_roles: [] }),
    });
    const people = r.data.people.filter((p) => /^https?:\/\//.test(p.source_url) && !/linkedin\.com/i.test(p.source_url) && p.full_name.trim().split(/\s+/).length >= 2).slice(0, 12);
    const existing = await existingPeople(db, ws, people.map((p) => p.full_name), people.flatMap((p) => p.emails_published));
    let n = 0;
    for (const p of people) {
      await buildItem(db, ws, job.id, org, { full_name: p.full_name, title: p.title, location: p.location, emails: p.emails_published.filter((e) => e.includes("@")), phones: p.phones_published, phone_is_mobile: !!p.phone_is_mobile,
        profile: p.profile_url && !/linkedin\.com/i.test(p.profile_url) ? p.profile_url : null, source_url: p.source_url, source_name: p.source_name, published_on: p.published_on && /^\d{4}-\d{2}-\d{2}$/.test(p.published_on) ? p.published_on : null, responsibilities: p.responsibilities, source_type: p.source_type }, existing, "web_search");
      n++;
    }
    const sites = r.web?.sources ?? [];
    await db.from("enrichment_job").update({
      status: r.mocked ? "failed" : "done", total: n, done: n, usd: r.usage.usd, queries: r.web?.queries ?? [],
      sites: sites.map((s) => ({ ...s, used: people.some((p) => p.source_url === s.url) })).slice(0, 40),
      error: r.mocked ? (r.model.startsWith("fallback:") ? "Web search failed or its answer couldn't be read — press Retry." : "Web research is off (no AI key). Only your records were checked.") : n ? null : "No relevant people were found on public company sources.",
      finished_at: new Date().toISOString(),
    }).eq("id", job.id);
    if (r.data.company_contact?.switchboard) {
      const pi = phoneInfo(r.data.company_contact.switchboard, { onCompanyContactPage: true });
      await db.from("enrichment_job").update({ sites: [...sites.map((s) => ({ ...s, used: people.some((p) => p.source_url === s.url) })).slice(0, 39), { url: r.data.company_contact.contact_page_url ?? "", title: `Switchboard: ${pi.display}`, used: true }] }).eq("id", job.id);
    }
    return { jobId: job.id, found: n, mocked: r.mocked, suggested: r.data.suggested_roles.slice(0, 3) };
  } catch (e) {
    await db.from("enrichment_job").update({ status: "failed", error: String((e as Error).message).slice(0, 300), finished_at: new Date().toISOString() }).eq("id", job.id);
    if (e instanceof AiUnavailableError) throw new ContactError(e.message);
    throw e;
  }
}

/** Enrich one existing contact: re-check channels (rules) and look for current role / published business contact (web). */
export async function enrichPerson(db: Db, ws: string, personId: string, opts: { userId?: string; ai?: typeof callStructured; jobId?: string; web?: boolean } = {}) {
  const ai = opts.ai ?? callStructured;
  const { data: p } = await db.from("person").select("id, full_name, do_not_contact, employment(id, title, is_current, fact_status, org:org_id(id, display_name, domain))").eq("workspace_id", ws).eq("id", personId).maybeSingle();
  if (!p) throw new ContactError("Contact not found.");
  const cur = (p.employment ?? []).find((e: Row) => e.is_current);
  const org = cur?.org as Row | undefined;
  const job = opts.jobId ? { id: opts.jobId, reused: false } : await startJob(db, ws, "contact_enrich", `Enrich ${p.full_name}`, org?.id ?? null, opts.userId, null, ["records", "mx", ...(opts.web === false ? [] : ["web"])]);
  // 1) Re-check existing channels deterministically (status/evidence only; never changes the value).
  const { data: methods } = await db.from("contact_method").select("id, method_type, value, verify_status").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null);
  for (const m of methods ?? []) {
    if (m.method_type === "email") {
      if (m.verify_status === "verified") continue;     // never downgrade a verified value
      const mx = await hasMx(String(m.value).split("@")[1] ?? "");
      const es = emailStatus({ email: m.value, companyDomain: org?.domain, mx });
      await db.from("contact_method").update({ verify_status: es.status === "unverified" && m.verify_status === "likely_valid" ? "likely_valid" : es.status, verify_evidence: es.evidence, last_checked_at: new Date().toISOString() }).eq("id", m.id);
    } else if (m.method_type === "phone" && !m.verify_status) {
      const pi = phoneInfo(m.value, { userProvided: true });
      await db.from("contact_method").update({ verify_status: pi.status, verify_evidence: [{ check: "format", ok: pi.status !== "invalid", note: `${pi.display}${pi.country ? ` (${pi.country})` : ""}. ${pi.note}`, at: new Date().toISOString() }], last_checked_at: new Date().toISOString() }).eq("id", m.id);
    }
  }
  // 2) Web: current role + published business channels for this person at this company.
  let found = 0;
  if (org && opts.web !== false) {
    try {
      const r = await ai({
        workspaceId: ws, workflow: "contacts.enrich", tier: "luna", webSearch: true, classification: "public", schema: Found, schemaName: "people_found", maxOutputTokens: 1000,
        system: "You verify one professional's current role from public company sources (official site, press releases, reputable news). Report only what a source states, with its URL. Emails/phones ONLY if published for this person. Never guess. Never use LinkedIn. If the person now appears at another company, report that with its source.",
        input: `Person: ${p.full_name}. Recorded as: ${cur?.title ?? "unknown title"} at ${org.display_name}${org.domain ? ` (${org.domain})` : ""}.\nConfirm current company and designation, responsibilities, and any published business email/phone. Return at most 2 entries (current role; and a different employer only if a source shows a move).`,
        mock: () => ({ people: [], company_contact: null, suggested_roles: [] }),
      });
      const existing = await existingPeople(db, ws, [p.full_name], []);
      for (const f of r.data.people.filter((x) => /^https?:\/\//.test(x.source_url) && !/linkedin\.com/i.test(x.source_url)).slice(0, 2)) {
        await buildItem(db, ws, job.id, org, { full_name: f.full_name, title: f.title, location: f.location, emails: f.emails_published, phones: f.phones_published, phone_is_mobile: !!f.phone_is_mobile, profile: null, source_url: f.source_url, source_name: f.source_name, published_on: f.published_on && /^\d{4}-\d{2}-\d{2}$/.test(f.published_on) ? f.published_on : null }, existing, "web_search");
        found++;
      }
      await db.from("enrichment_job").update({ usd: r.usage.usd, queries: r.web?.queries ?? [], sites: (r.web?.sources ?? []).slice(0, 30) }).eq("id", job.id);
    } catch (e) { if (!(e instanceof AiUnavailableError)) throw e; }
  }
  await db.from("person").update({ last_enriched_at: new Date().toISOString(), next_review_on: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10) }).eq("id", personId);
  if (!opts.jobId) await db.from("enrichment_job").update({ status: "done", total: 1, done: 1, finished_at: new Date().toISOString(), error: found ? null : "Channels re-checked. No newer public information found." }).eq("id", job.id);
  return { jobId: job.id, found };
}

/** Bulk: enrich many contacts (or all contacts at chosen companies) with a parallel pool, time budget and retry. */
export async function enrichMany(db: Db, ws: string, input: { personIds?: string[]; orgIds?: string[]; web: boolean; userId?: string; jobId?: string }) {
  let ids = [...new Set(input.personIds ?? [])];
  if (input.orgIds?.length) {
    const { data } = await db.from("employment").select("person_id").eq("workspace_id", ws).in("org_id", input.orgIds).eq("is_current", true).is("archived_at", null);
    ids = [...new Set([...ids, ...(data ?? []).map((r) => r.person_id)])];
  }
  if (!ids.length) throw new ContactError("Pick at least one contact or company.");
  const { data: dnc } = await db.from("person").select("id").eq("workspace_id", ws).in("id", ids).eq("do_not_contact", true);
  const skip = new Set((dnc ?? []).map((r) => r.id));
  ids = ids.filter((id) => !skip.has(id)).slice(0, 200);
  const job = input.jobId ? { id: input.jobId } : await startJob(db, ws, "bulk", `Enrich ${ids.length} contact(s)`, null, input.userId, null, ["records", "mx", ...(input.web ? ["web"] : [])]);
  await db.from("enrichment_job").update({ total: ids.length, status: "running" }).eq("id", job.id);
  let done = 0, failed = 0, i = 0;
  const deadline = Date.now() + 45_000;
  const worker = async () => { while (i < ids.length && Date.now() < deadline) { const id = ids[i++]; try { await enrichPerson(db, ws, id, { userId: input.userId, jobId: job.id, web: input.web }); done++; } catch { failed++; } } };
  await Promise.all(Array.from({ length: Math.min(input.web ? 3 : 8, ids.length) }, worker));
  const left = ids.length - done - failed;
  await db.from("enrichment_job").update({ done, failed, status: left ? "partial" : failed ? "partial" : "done", error: left ? `${left} not reached in this run — press Retry to continue.` : failed ? `${failed} failed — press Retry.` : null, finished_at: new Date().toISOString() }).eq("id", job.id);
  return { jobId: job.id, done, failed, left, skippedDoNotContact: skip.size };
}

/** Retry a failed/partial job: re-runs discovery, or bulk enrichment for contacts not yet enriched in this job. */
export async function retryJob(db: Db, ws: string, jobId: string, userId?: string) {
  const { data: j } = await db.from("enrichment_job").select("*").eq("workspace_id", ws).eq("id", jobId).single();
  if (!j) throw new ContactError("Job not found.");
  if (j.kind === "company_discovery" && j.org_id) return discoverCompany(db, ws, j.org_id, { userId, force: true });
  if (j.kind === "appointment_scan") { await db.from("enrichment_job").update({ idempotency_key: null }).eq("id", jobId); return appointmentScan(db, ws, { userId }); }
  if (j.kind === "contact_enrich" || j.kind === "bulk") {
    const { data: items } = await db.from("enrichment_item").select("person_id").eq("job_id", jobId);
    const done = new Set((items ?? []).map((x) => x.person_id));
    return enrichMany(db, ws, { personIds: [...done].filter(Boolean) as string[], web: (j.sources ?? []).includes("web"), userId, jobId });
  }
  throw new ContactError("This job cannot be retried.");
}

// ------------------------------------------------------------------ review → Module 1 (change proposals) → Module 3

async function apply(db: Db, ws: string, userId: string, input: Parameters<typeof proposeChange>[2], autoApply = true) {
  const p = await proposeChange(db, ws, { ...input, actorUserId: userId, proposedByKind: "user" } as never);
  if (!autoApply || p.state === "applied") return { id: p.id as string, target: (p as Row).target_id as string | null, applied: p.state === "applied" };
  try { const r = await approveAndApply(db, p.id, { actorUserId: userId, note: "Approved in Contact enrichment review" }); return { id: p.id as string, target: r.applied.target_id, applied: true }; }
  catch { return { id: p.id as string, target: null, applied: false }; }   // needs admin approval → stays in Review
}

/**
 * Approve a reviewed item. `as`: "new" create a person; "<personId>" treat as that existing person (user's identity choice).
 * Job changes become a person-move proposal (old role kept as history) that waits in Review.
 */
export async function approveItem(db: Db, ws: string, userId: string, itemId: string, as?: string | null) {
  const { data: it } = await db.from("enrichment_item").select("*, org:org_id(id, display_name)").eq("workspace_id", ws).eq("id", itemId).single();
  if (!it) throw new ContactError("Item not found.");
  if (it.decision !== "pending") throw new ContactError("Already reviewed.");
  const fields = it.fields as Row[];
  const val = (f: string) => fields.find((x) => x.field === f && x.value)?.value ?? null;
  const evidence = `${fields.find((x) => x.source_url)?.source_name ?? "source"} ${fields.find((x) => x.source_url)?.source_url ?? ""}`.trim();
  const proposals: string[] = [];
  // Company not yet in records (LinkedIn export / appointment news): match by exact name, else add it (with the user's approval).
  let orgId: string | null = it.org_id;
  if (!orgId && it.company_raw) {
    const { resolveOrg } = await import("@/modules/signals/service");
    orgId = (await resolveOrg(db, ws, it.company_raw)).orgId;
    if (!orgId) {
      const r = await apply(db, ws, userId, { targetType: "organisation", operation: "create", patch: [{ op: "add", path: "/display_name", value: it.company_raw }], reason: `Company of a contact approved from ${it.source_type ?? "enrichment"}`, idempotencyKey: `contacts.org:${normName(it.company_raw)}` });
      proposals.push(r.id); orgId = r.target;
    }
    if (orgId) await db.from("enrichment_item").update({ org_id: orgId }).eq("id", itemId);
  }
  let personId: string | null = as && as !== "new" ? as : it.person_id;
  if (it.match_kind === "possible_duplicate" && !as) throw new ContactError("Choose whether this is an existing contact or a new person.");
  if (!personId) {
    const r = await apply(db, ws, userId, { targetType: "person", operation: "create", patch: [{ op: "add", path: "/full_name", value: it.full_name }, ...(val("profile") ? [{ op: "add" as const, path: "/public_profile_url", value: val("profile") }] : [])], reason: `New contact from enrichment (${evidence})`, idempotencyKey: `contacts.person:${it.id}` });
    proposals.push(r.id); personId = r.target;
    if (!personId) throw new ContactError("Creating the person needs approval in Review first.");
  }
  // Employment: new person / existing without this company → create; job change → person move (Review).
  const { data: emps } = await db.from("employment").select("id, org_id, title, is_current, fact_status, row_version").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null);
  const here = (emps ?? []).find((e) => e.is_current && e.org_id === orgId);
  const elsewhere = (emps ?? []).filter((e) => e.is_current && e.org_id !== orgId);
  if (orgId && !here && elsewhere.length) {
    const ps = await proposePersonMove(db, ws, { personId, newOrgId: orgId, title: val("designation"), reason: `Employment change found by enrichment (${evidence})`, idempotencyKey: `contacts.move:${it.id}`, actorUserId: userId } as never);
    proposals.push(...(ps as Row[]).map((x) => x.id));
  } else if (orgId && !here) {
    const r = await apply(db, ws, userId, { targetType: "employment", operation: "create", patch: [{ op: "add", path: "/person_id", value: personId }, { op: "add", path: "/org_id", value: orgId }, { op: "add", path: "/title", value: val("designation") }, { op: "add", path: "/is_current", value: true }, { op: "add", path: "/fact_status", value: "reported" }], reason: `Role from enrichment (${evidence})`, idempotencyKey: `contacts.emp:${it.id}` });
    proposals.push(r.id);
  } else if (here && val("designation") && val("designation") !== here.title) {
    // Title differs: a confirmed title is never overwritten automatically — that proposal waits in Review.
    const r = await apply(db, ws, userId, { targetType: "employment", targetId: here.id, operation: "update", expectedVersion: here.row_version, patch: [{ op: "replace", path: "/title", value: val("designation") }], reason: `Designation update from enrichment (${evidence})`, idempotencyKey: `contacts.title:${it.id}` }, here.fact_status !== "currently_confirmed");
    proposals.push(r.id);
  }
  // Channels: add only new values; existing verified values are untouched. Invalid/missing are never stored.
  const { data: have } = await db.from("contact_method").select("value").eq("workspace_id", ws).eq("person_id", personId);
  const known = new Set((have ?? []).map((m) => String(m.value).toLowerCase()));
  for (const f of fields.filter((x) => (x.field === "email" || x.field === "phone") && x.value && !["invalid", "missing"].includes(x.status))) {
    if (known.has(String(f.value).toLowerCase())) continue;
    const r = await apply(db, ws, userId, { targetType: "contact_method", operation: "create", patch: [
      { op: "add", path: "/person_id", value: personId }, { op: "add", path: "/method_type", value: f.field }, { op: "add", path: "/value", value: f.value },
      { op: "add", path: "/verify_status", value: f.status }, { op: "add", path: "/verify_evidence", value: f.evidence ?? [] },
      { op: "add", path: "/source_name", value: f.source_name ?? null }, { op: "add", path: "/source_url", value: f.source_url ?? null }, { op: "add", path: "/observed_on", value: f.observed_on ?? null },
    ], reason: `Business ${f.field} from ${f.source_name ?? "enrichment"}`, idempotencyKey: `contacts.cm:${it.id}:${String(f.value).toLowerCase()}` });
    proposals.push(r.id);
  }
  // Role assessment (rules), feeding Module 3 through the scoring trigger.
  await db.from("contact_role_assessment").update({ active: false }).eq("workspace_id", ws).eq("person_id", personId).eq("source", "rules").eq("active", true);
  await db.from("contact_role_assessment").insert({ workspace_id: ws, person_id: personId, org_id: orgId, role_class: it.role_class ?? "unknown", department: it.department, cre_relevance: it.cre_relevance ?? "unknown", reason: it.role_reason ?? "Rules", evidence: fields.filter((x) => x.source_url).slice(0, 3).map((x) => ({ source_name: x.source_name, source_url: x.source_url, observed_on: x.observed_on })), source: "rules", owner_user_id: userId });
  await db.from("person").update({ last_enriched_at: new Date().toISOString(), next_review_on: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10) }).eq("id", personId);
  await db.from("enrichment_item").update({ decision: "approved", stage: "verified", person_id: personId, reviewed_by: userId, reviewed_at: new Date().toISOString(), proposal_ids: proposals }).eq("id", itemId);
  try { await scoreEntity(db, ws, "contact", personId, "enrichment"); } catch { /* scoring off */ }
  return { personId, proposals };
}

export async function rejectItem(db: Db, ws: string, userId: string, itemId: string, reason: string) {
  if (!reason?.trim()) throw new ContactError("Give a reason.");
  await db.from("enrichment_item").update({ decision: "rejected", stage: "rejected", decision_reason: reason.trim(), reviewed_by: userId, reviewed_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", itemId).eq("decision", "pending");
}

// ------------------------------------------------------------------ profile actions

export async function setRole(db: Db, ws: string, userId: string, personId: string, role: string, relevance: string, reason: string) {
  if (!reason?.trim()) throw new ContactError("Give a reason for the correction.");
  const { data: e } = await db.from("employment").select("org_id, title").eq("workspace_id", ws).eq("person_id", personId).eq("is_current", true).limit(1).maybeSingle();
  await db.from("contact_role_assessment").update({ active: false }).eq("workspace_id", ws).eq("person_id", personId).eq("active", true);
  const { error } = await db.from("contact_role_assessment").insert({ workspace_id: ws, person_id: personId, org_id: e?.org_id ?? null, role_class: role, department: classify(e?.title).department, cre_relevance: relevance, reason: reason.trim(), source: "user", owner_user_id: userId });
  if (error) throw new ContactError(error.message);
  try { await scoreEntity(db, ws, "contact", personId, "role_correction"); } catch { /* */ }
}
export async function confirmChannel(db: Db, ws: string, methodId: string, how: string) {
  const { data: m } = await db.from("contact_method").select("verify_evidence").eq("workspace_id", ws).eq("id", methodId).single();
  const ev = [...((m?.verify_evidence ?? []) as Row[]), { check: "confirmed", ok: true, note: how || "Confirmed by user", at: new Date().toISOString() }];
  await db.from("contact_method").update({ verify_status: "verified", verified_on: today(), verify_evidence: ev, last_checked_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", methodId);
}
export async function setDoNotContact(db: Db, ws: string, personId: string, on: boolean, reason: string) {
  await db.from("person").update({ do_not_contact: on, contact_restrictions: on ? `Do not contact: ${reason || "requested"}` : null }).eq("workspace_id", ws).eq("id", personId);
  if (on) await db.from("contact_method").update({ suppressed: true }).eq("workspace_id", ws).eq("person_id", personId);
}
export async function flagDuplicate(db: Db, ws: string, userId: string, keepId: string, dupId: string, reason: string) {
  if (keepId === dupId) throw new ContactError("Pick a different contact.");
  return proposeMerge(db, ws, { entityType: "person", winnerId: keepId, loserId: dupId, reason: reason || "Flagged as duplicate in Contact enrichment", actorUserId: userId, idempotencyKey: `contacts.merge:${keepId}:${dupId}` } as never);
}
export async function setManager(db: Db, ws: string, userId: string, orgId: string, personId: string, managerId: string | null, note: string) {
  await db.from("reporting_line").update({ archived_at: new Date().toISOString() }).eq("workspace_id", ws).eq("org_id", orgId).eq("person_id", personId).is("archived_at", null);
  if (managerId) {
    const { error } = await db.from("reporting_line").insert({ workspace_id: ws, org_id: orgId, person_id: personId, manager_person_id: managerId, note: note || "Set manually", owner_user_id: userId });
    if (error) throw new ContactError(error.message);
  }
}

/** Scheduled review: contacts due for re-verification (rules only, no web) — never re-enriches verified data without a reason. */
export async function reverifyDue(db: Db, ws: string) {
  const { data } = await db.from("person").select("id").eq("workspace_id", ws).is("archived_at", null).eq("do_not_contact", false).lte("next_review_on", today()).limit(100);
  const ids = (data ?? []).map((r) => r.id);
  return ids.length ? enrichMany(db, ws, { personIds: ids, web: false }) : { jobId: null, done: 0, failed: 0, left: 0, skippedDoNotContact: 0 };
}

// ------------------------------------------------------------------ appointment news (free): new roles + job changes

/** Scans recent appointment news ("X joins Y as Head of Admin") for CRE-relevant roles in the focus cities. */
export async function appointmentScan(db: Db, ws: string, opts: { userId?: string; ai?: typeof callStructured; city?: string } = {}) {
  const ai = opts.ai ?? callStructured;
  const city = opts.city ?? "Pune";
  const job = await startJob(db, ws, "appointment_scan", `Appointment news — ${city}`, null, opts.userId, `appointments:${today()}`, ["web"]);
  if (job.reused) return { jobId: job.id, reused: true, found: 0 };
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  try {
    const r = await ai({
      workspaceId: ws, workflow: "contacts.appointments", tier: "luna", webSearch: true, classification: "public", schema: Found, schemaName: "people_found", maxOutputTokens: 1800,
      system: "You scan Indian business news for executive appointments relevant to office real estate. Report only appointments stated in a source, each with the person's name, new title, new company (in 'company'), URL and source_type 'appointment_news'. Never use LinkedIn. Never guess emails or phones.",
      input: `Find appointment news since ${since} for roles: ${TARGET_ROLES} — in ${city} or India-wide for companies with ${city} offices. Phrases like "joins as", "appointed", "named head of". Up to 12.`,
      mock: () => ({ people: [], company_contact: null, suggested_roles: [] }),
    });
    const { resolveOrg } = await import("@/modules/signals/service");
    const people = r.data.people.filter((p) => /^https?:\/\//.test(p.source_url) && !/linkedin\.com/i.test(p.source_url) && p.company).slice(0, 15);
    const existing = await existingPeople(db, ws, people.map((p) => p.full_name), []);
    let n = 0;
    for (const p of people) {
      const res = await resolveOrg(db, ws, p.company!);
      const org = res.orgId ? (await db.from("organisation").select("id, display_name, domain").eq("id", res.orgId).single()).data : null;
      await buildItem(db, ws, job.id, org, { full_name: p.full_name, title: p.title, location: p.location, emails: [], phones: [], profile: null, source_url: p.source_url, source_name: p.source_name,
        published_on: p.published_on && /^\d{4}-\d{2}-\d{2}$/.test(p.published_on) ? p.published_on : null, source_type: "appointment_news", company_raw: p.company }, existing, "web_search");
      n++;
    }
    await db.from("enrichment_job").update({ status: r.mocked ? "failed" : "done", total: n, done: n, usd: r.usage.usd, queries: r.web?.queries ?? [], sites: (r.web?.sources ?? []).slice(0, 40),
      error: r.mocked ? "Web research is off or failed — press Retry." : n ? null : "No relevant appointments found.", finished_at: new Date().toISOString() }).eq("id", job.id);
    return { jobId: job.id, reused: false, found: n };
  } catch (e) {
    await db.from("enrichment_job").update({ status: "failed", error: String((e as Error).message).slice(0, 300), finished_at: new Date().toISOString() }).eq("id", job.id);
    throw e;
  }
}

// ------------------------------------------------------------------ LinkedIn connections export (your own data, free)

/** Parses LinkedIn's Connections.csv (skips the note lines before the header). Handles quoted commas. */
export function parseLinkedInCsv(text: string): { first: string; last: string; url: string; email: string; company: string; position: string; connected: string }[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const hi = lines.findIndex((l) => /first name/i.test(l) && /last name/i.test(l));
  if (hi < 0) throw new ContactError("This doesn't look like LinkedIn's Connections.csv (no 'First Name, Last Name' header).");
  const split = (l: string) => { const out: string[] = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[hi]).map((h) => h.toLowerCase());
  const col = (n: string) => head.findIndex((h) => h === n);
  const idx = { first: col("first name"), last: col("last name"), url: col("url"), email: col("email address"), company: col("company"), position: col("position"), connected: col("connected on") };
  return lines.slice(hi + 1).filter((l) => l.trim()).map(split).map((c) => ({
    first: c[idx.first] ?? "", last: c[idx.last] ?? "", url: idx.url >= 0 ? c[idx.url] ?? "" : "", email: idx.email >= 0 ? c[idx.email] ?? "" : "",
    company: idx.company >= 0 ? c[idx.company] ?? "" : "", position: idx.position >= 0 ? c[idx.position] ?? "" : "", connected: idx.connected >= 0 ? c[idx.connected] ?? "" : "",
  })).filter((r) => (r.first + r.last).trim());
}

/** Imports your connections as reviewable items (CRE-relevant roles first). Nothing is saved until approved. */
export async function importLinkedIn(db: Db, ws: string, text: string, opts: { userId?: string; onlyRelevant?: boolean } = {}) {
  const rows = parseLinkedInCsv(text);
  if (!rows.length) throw new ContactError("No connections found in the file.");
  const picked = rows.filter((r) => !opts.onlyRelevant || ["high", "medium"].includes(classify(r.position).relevance)).slice(0, 2000);
  const job = await startJob(db, ws, "linkedin_import", `LinkedIn connections import (${picked.length} of ${rows.length})`, null, opts.userId, null, ["linkedin_export"]);
  const { resolveOrg } = await import("@/modules/signals/service");
  const orgCache = new Map<string, Row | null>();
  let n = 0;
  for (let i = 0; i < picked.length; i += 50) {
    const chunk = picked.slice(i, i + 50);
    const existing = await existingPeople(db, ws, chunk.map((r) => `${r.first} ${r.last}`), chunk.map((r) => r.email).filter((e) => e.includes("@")));
    for (const r of chunk) {
      const key = r.company.toLowerCase();
      if (r.company && !orgCache.has(key)) {
        const id = (await resolveOrg(db, ws, r.company)).orgId;
        orgCache.set(key, id ? (await db.from("organisation").select("id, display_name, domain").eq("id", id).single()).data : null);
      }
      const connected = Date.parse(r.connected);
      await buildItem(db, ws, job.id, r.company ? orgCache.get(key) ?? null : null, {
        full_name: `${r.first} ${r.last}`.trim(), title: r.position || null, location: null, emails: r.email.includes("@") ? [r.email] : [], phones: [],
        profile: r.url || null, source_url: null, source_name: "Your LinkedIn connections export", published_on: Number.isFinite(connected) ? new Date(connected).toISOString().slice(0, 10) : today(),
        company_raw: r.company || null,
      }, existing, "linkedin_export");
      n++;
    }
  }
  await db.from("enrichment_job").update({ status: "done", total: n, done: n, finished_at: new Date().toISOString() }).eq("id", job.id);
  return { jobId: job.id, imported: n, total: rows.length };
}
