/**
 * Grounded lease answers for the Supercharged Assistant (SPEC §16, Module 12). Pattern routing in code; every answer
 * is built from recorded lease rows and cites the source (document + page / verification status). No free-text AI.
 * Wire-up: the assistant module can call `answerLeaseQuestion` as a tool (see README).
 */
import { addDays } from "./dates";
import { alternativeProperties, escalationView, getLease, listLeases, scanOpportunities, upcomingDates, type W } from "./service";
import { VERIFICATION_LABEL, type VerificationStatus } from "./dates";

export interface LeaseAnswer { intent: string; answer: string; rows: { leaseId: string; tenant: string | null; date?: string | null; value?: string | null; status?: string; source?: string | null }[]; grounded: true }

const src = (d: { page?: number | null; document_id?: string | null; method?: string | null }, titles: Map<string, string>) =>
  d.document_id ? `${titles.get(d.document_id) ?? "document"}${d.page ? ` p.${d.page}` : ""}` : d.method ?? "entered by user";

async function docTitles(w: W, ids: string[]) {
  const m = new Map<string, string>();
  if (ids.length) for (const r of (await w.db.from("lease_document").select("id, title, version").in("id", ids)).data ?? []) m.set(r.id, `${r.title} v${r.version}`);
  return m;
}

export async function answerLeaseQuestion(w: W, question: string, today: string, opts: { leaseId?: string; orgName?: string; orgId?: string } = {}): Promise<LeaseAnswer> {
  const q = question.toLowerCase();
  // A specific company/lease named → answer about that lease (not the whole-workspace window).
  if (/expir/.test(q) && !/notice/.test(q) && (opts.leaseId || opts.orgId || opts.orgName || /\b(the lease for|lease of|'s lease)\b/.test(q))) {
    const all = opts.leaseId ? [] : await listLeases(w, opts.orgId ? { orgId: opts.orgId } : {});
    const target = opts.leaseId ? [opts.leaseId]
      : opts.orgId ? all.map((l) => l.id)
      : all.filter((l) => (l.tenant_name && q.includes(String(l.tenant_name).toLowerCase())) || (opts.orgName && String(l.tenant_name ?? "").toLowerCase() === opts.orgName.toLowerCase())).map((l) => l.id);
    if (target.length) {
      const rows: LeaseAnswer["rows"] = [];
      for (const id of target.slice(0, 10)) {
        const d = await getLease(w, id); if (!d) continue;
        const ex = d.dates.filter((x) => x.date_type === "expiry" && !x.superseded_by && !x.archived_at);
        const titles = await docTitles(w, ex.map((r) => r.document_id).filter(Boolean));
        if (ex.length) for (const r of ex) rows.push({ leaseId: id, tenant: d.lease.tenant_name ?? null, date: r.calculated_date, status: VERIFICATION_LABEL[r.verification_status as VerificationStatus], source: src(r, titles) });
        else rows.push({ leaseId: id, tenant: d.lease.tenant_name ?? null, date: d.lease.contractual_expiry ?? null, status: d.lease.contractual_expiry ? "recorded on the lease (not verified in Lease Lifecycle)" : "unknown", source: d.lease.contractual_expiry ? "lease record" : null });
      }
      const known = rows.filter((r) => r.date);
      return { intent: "lease_expiry", rows, grounded: true, answer: known.length ? known.map((r) => `${r.tenant ?? "Lease"} expires ${r.date} (${r.status}${r.source ? `; source: ${r.source}` : ""})`).join(". ") + "." : `No expiry date is recorded for ${rows[0]?.tenant ?? "this lease"} — unknown.` };
    }
  }
  const window = async (types: string[], days: number, intent: string, title: string) => {
    const rows = await upcomingDates(w, { from: today, to: addDays(today, days), types, includeUnverified: true });
    const titles = await docTitles(w, rows.map((r) => r.document_id).filter(Boolean));
    const out = rows.map((r) => ({ leaseId: r.lease_id, tenant: r.lease.tenant_name ?? null, date: r.calculated_date, status: VERIFICATION_LABEL[r.verification_status as VerificationStatus], source: src(r, titles) }));
    const conf = out.filter((r) => r.status === VERIFICATION_LABEL.confirmed).length;
    return { intent, rows: out, grounded: true as const, answer: out.length ? `${out.length} ${title} (${conf} confirmed contractual, ${out.length - conf} not yet verified).` : `No recorded ${title}.` };
  };
  if (/expir/.test(q) && !/notice/.test(q)) return window(["expiry"], /24|two years/.test(q) ? 730 : /6 months|six months/.test(q) ? 183 : 365, "expiries", "lease expiries in the window");
  if (/renewal/.test(q) && /(deadline|notice)/.test(q)) return window(["renewal_notice_deadline"], 365, "renewal_deadlines", "renewal notice deadlines in the next 12 months");
  if (/escalat/.test(q)) return window(["escalation"], 365, "escalations", "rent escalations in the next 12 months");
  if (/lock-?\s?in/.test(q)) return window(["lockin_end"], 365, "lockins", "lock-in completions in the next 12 months");
  if (/break/.test(q)) return window(["break_option"], 3650, "breaks", "break options");
  if (/(contact|reach out|call).*renew|renew.*(contact|reach out)/.test(q)) {
    const opps = await scanOpportunities(w, today);
    const rows = opps.filter((o) => o.kind === "expiry_approaching").map((o) => ({ leaseId: o.lease_id, tenant: o.title.split(":")[0], date: o.due, status: o.basis, source: "lease records" }));
    return { intent: "contact_renewals", rows, grounded: true, answer: rows.length ? `${rows.length} clients with upcoming expiries — potential renewal conversations (not confirmed requirements).` : "No upcoming expiries recorded." };
  }
  // per-lease questions need a lease: explicit id, or a tenant name in the question
  let leaseId = opts.leaseId ?? null;
  if (!leaseId) {
    const leases = await listLeases(w);
    const hit = leases.find((l) => l.tenant_name && q.includes(String(l.tenant_name).toLowerCase())) ?? (opts.orgName ? leases.find((l) => String(l.tenant_name ?? "").toLowerCase() === opts.orgName!.toLowerCase()) : null);
    leaseId = hit?.id ?? null;
  }
  if (!leaseId) return { intent: "unknown", rows: [], grounded: true, answer: "I couldn't tell which lease you mean — name the tenant or open the lease." };
  const d = await getLease(w, leaseId);
  if (!d) return { intent: "unknown", rows: [], grounded: true, answer: "Lease not found or not visible to you." };
  const tenant = d.lease.tenant_name ?? null;
  if (/current rent|rent for|monthly rent/.test(q)) {
    const t = d.currentTerms; const v = d.currentTermVersion;
    const titles = await docTitles(w, v?.document_id ? [v.document_id] : []);
    const esc = await escalationView(w, leaseId).catch(() => null);
    const applied = esc?.rows.filter((r) => r.effectiveDate && r.effectiveDate <= today).slice(-1)[0];
    return { intent: "current_rent", grounded: true, rows: [{ leaseId, tenant, value: t.monthlyRent == null ? null : String(t.monthlyRent), status: v?.confirmed_at ? "confirmed terms" : "terms not confirmed", source: v?.document_id ? titles.get(v.document_id) : v?.note ?? null }],
      answer: t.monthlyRent == null ? `Rent for ${tenant} is not recorded.` : `Recorded base monthly rent for ${tenant}: ₹${t.monthlyRent}${applied?.expectedMonthlyRent ? `; expected after escalation on ${applied.effectiveDate}: ₹${applied.expectedMonthlyRent} (calculated — ${applied.check.status === "unknown" ? "actual not recorded" : applied.check.status})` : ""}.` };
  }
  if (/notice/.test(q)) {
    const rows = d.dates.filter((x) => /notice/.test(x.date_type) && !x.superseded_by && !x.archived_at);
    const titles = await docTitles(w, rows.map((r) => r.document_id).filter(Boolean));
    return { intent: "notice_requirements", grounded: true, rows: rows.map((r) => ({ leaseId, tenant, date: r.calculated_date, value: r.clause_text, status: VERIFICATION_LABEL[r.verification_status as VerificationStatus], source: src(r, titles) })),
      answer: rows.length ? `Notice provisions recorded for ${tenant} (clause text quoted; not legal advice).` : `No notice clause recorded for ${tenant}.` };
  }
  if (/alternative|other propert|options/.test(q)) {
    const a = await alternativeProperties(w, leaseId);
    return { intent: "alternatives", grounded: true, rows: a.items.map((x) => ({ leaseId, tenant, value: `${x.asset ?? "?"} ${x.floor ?? ""} ${x.areaSf ?? "?"} sf`, status: x.factStatus, source: "Module 14 supply" })), answer: a.items.length ? `${a.items.length} recorded alternatives. ${a.note}` : "No matching available supply recorded." };
  }
  return { intent: "summary", grounded: true, rows: d.dates.filter((x) => !x.superseded_by && !x.archived_at).map((x) => ({ leaseId, tenant, date: x.calculated_date, value: x.date_type, status: VERIFICATION_LABEL[x.verification_status as VerificationStatus] })), answer: `Lease for ${tenant}: status ${d.lease.lifecycle_status}.` };
}
