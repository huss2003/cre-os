/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Entity lookup for the "Link to…" pickers (notes page and other assistant/toolkit forms).
 * Runs on the caller's RLS client with an explicit workspace filter (S1/S2). Read-only.
 */
import { format } from "date-fns";
import { containsLike } from "@/lib/util/like";

export type LookupKind = "company" | "requirement" | "meeting" | "person";
export interface LookupItem { id: string; label: string; context?: string; orgId?: string | null }
export interface LookupCtx { db: any; workspaceId: string }

const OPEN_REQ = ["closed", "lost", "won", "cancelled", "archived"];
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
/** Make user text safe inside a PostgREST ilike/or filter. */
export const safeTerm = (q: string) => q.replace(/[%_,()\\*:."']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const when = (iso?: string | null) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "date unknown");

function personItem(p: any): LookupItem {
  const jobs = (p.employment ?? []) as any[];
  const e = jobs.find((x) => x.is_current && !x.archived_at) ?? jobs[0];
  const org = one(e?.org) as any;
  return { id: p.id, label: p.full_name || "Unnamed contact", context: [e?.title, org?.display_name].filter(Boolean).join(" · ") || undefined, orgId: e?.org_id ?? null };
}
const PERSON_SEL = "id, full_name, employment(title, is_current, archived_at, org_id, org:org_id(display_name))";

function reqItem(r: any): LookupItem {
  const org = one(r.org) as any;
  return { id: r.id, label: r.title || `${org?.display_name ?? "Company"} requirement`, context: [org?.display_name, r.status?.replace(/_/g, " ")].filter(Boolean).join(" · "), orgId: r.org_id ?? null };
}

/** Search one entity kind. `q` needs 2+ characters, except requirements scoped to a company (lists its open ones). */
export async function lookupEntities(c: LookupCtx, kind: LookupKind, q: string, opts: { orgId?: string | null; limit?: number } = {}): Promise<LookupItem[]> {
  const term = safeTerm(q ?? "");
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  if (kind === "company") {
    if (term.length < 2) return [];
    const { data, error } = await c.db.from("organisation").select("id, display_name, legal_name, sector")
      .eq("workspace_id", c.workspaceId).is("archived_at", null)
      .or(`display_name.ilike.%${term}%,legal_name.ilike.%${term}%`).order("display_name").limit(limit);
    if (error) throw error;
    return (data ?? []).map((o: any) => ({ id: o.id, label: o.display_name, context: [o.legal_name && o.legal_name !== o.display_name ? o.legal_name : null, o.sector].filter(Boolean).join(" · ") || undefined }));
  }
  if (kind === "requirement") {
    if (!opts.orgId && term.length < 2) return [];
    let query = c.db.from("requirement").select("id, title, status, org_id, org:org_id(display_name)").eq("workspace_id", c.workspaceId).is("archived_at", null);
    if (opts.orgId) query = query.eq("org_id", opts.orgId).not("status", "in", `(${OPEN_REQ.join(",")})`);
    if (term.length >= 2) {
      // match the title, or the company's name
      const { data: orgs } = await c.db.from("organisation").select("id").eq("workspace_id", c.workspaceId).ilike("display_name", containsLike(term)).limit(50);
      const ids = (orgs ?? []).map((o: any) => o.id);
      query = query.or(ids.length ? `title.ilike.%${term}%,org_id.in.(${ids.join(",")})` : `title.ilike.%${term}%`);
    }
    const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map(reqItem);
  }
  if (kind === "person") {
    if (term.length < 2) return [];
    const { data, error } = await c.db.from("person").select(PERSON_SEL)
      .eq("workspace_id", c.workspaceId).is("archived_at", null).ilike("full_name", containsLike(term)).order("full_name").limit(limit);
    if (error) throw error;
    return (data ?? []).map(personItem);
  }
  // meetings: meeting_visit title (+ prep's company), newest first
  if (term.length < 2) return [];
  const { data, error } = await c.db.from("meeting_visit").select("id, title, start_at, linked_entity_type, linked_entity_id")
    .eq("workspace_id", c.workspaceId).is("archived_at", null).ilike("title", containsLike(term)).order("start_at", { ascending: false, nullsFirst: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).map((m: any) => ({ id: m.id, label: m.title || "Untitled meeting", context: when(m.start_at), orgId: m.linked_entity_type === "organisation" ? m.linked_entity_id : null }));
}

/** Resolve a prefilled id (e.g. ?requirement=) to its label; null when not visible. */
export async function lookupById(c: LookupCtx, kind: LookupKind, id: string): Promise<LookupItem | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (kind === "company") {
    const { data } = await c.db.from("organisation").select("id, display_name").eq("workspace_id", c.workspaceId).eq("id", id).maybeSingle();
    return data ? { id: data.id, label: data.display_name } : null;
  }
  if (kind === "requirement") {
    const { data } = await c.db.from("requirement").select("id, title, status, org_id, org:org_id(display_name)").eq("workspace_id", c.workspaceId).eq("id", id).maybeSingle();
    return data ? reqItem(data) : null;
  }
  if (kind === "person") {
    const { data } = await c.db.from("person").select(PERSON_SEL).eq("workspace_id", c.workspaceId).eq("id", id).maybeSingle();
    return data ? personItem(data) : null;
  }
  const { data: m } = await c.db.from("meeting_visit").select("id, title, start_at").eq("workspace_id", c.workspaceId).eq("id", id).maybeSingle();
  if (m) return { id: m.id, label: m.title || "Untitled meeting", context: when(m.start_at) };
  // a meeting_prep id is accepted too (service resolves either)
  const { data: p } = await c.db.from("meeting_prep").select("id, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", c.workspaceId).eq("id", id).maybeSingle();
  const pm = one(p?.meeting) as any;
  return p ? { id: p.id, label: pm?.title || "Untitled meeting", context: when(pm?.start_at) } : null;
}
