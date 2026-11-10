"use server";
import { revalidatePath } from "next/cache";
import { requireContext, hasRole } from "@/lib/auth/context";
import { createMeeting } from "@/modules/meetings/service";

/**
 * Tutorial practice data. Creates a small, clearly-labelled set of records in the user's own workspace through the
 * user's RLS-scoped client (never the admin client), so the hands-on tutorials have something real to click.
 * Idempotent: records are found by their "(tutorial)" names and only missing ones are created. Nothing here sends
 * anything (S3) — the contact's email uses the reserved .example domain. "Remove" archives, it never deletes.
 */
type Row = Record<string, any>;
type Db = Awaited<ReturnType<typeof requireContext>>["db"];

const PRACTICE = {
  company: "Practice Co (tutorial)",
  contact: "Priya Sharma (tutorial)",
  email: "priya.sharma@practice-co.example",
  requirement: "Practice Co — 25,000 sf in Kharadi (tutorial)",
  opportunity: "Practice Co — Kharadi office (tutorial)",
  signal: "Practice Co plans Pune expansion (tutorial)",
  meeting: "Practice Co — requirement discussion (tutorial)",
} as const;

export type PracticeIds = { company?: string; contact?: string; requirement?: string; opportunity?: string; signal?: string; meeting?: string; outreach?: string };
export type PracticeStatus = { exists: boolean; complete: boolean; ids: PracticeIds; canEdit: boolean };

async function find(db: Db, ws: string): Promise<PracticeIds> {
  const ids: PracticeIds = {};
  const one = async (table: string, col: string, val: string) => {
    const { data } = await db.from(table).select("id").eq("workspace_id", ws).eq(col, val).is("archived_at", null).order("created_at").limit(1);
    return (data?.[0] as Row | undefined)?.id as string | undefined;
  };
  [ids.company, ids.contact, ids.requirement, ids.opportunity, ids.signal] = await Promise.all([
    one("organisation", "display_name", PRACTICE.company), one("person", "full_name", PRACTICE.contact),
    one("requirement", "title", PRACTICE.requirement), one("opportunity", "name", PRACTICE.opportunity), one("signal", "title", PRACTICE.signal),
  ]);
  const { data: mv } = await db.from("meeting_visit").select("id").eq("workspace_id", ws).eq("title", PRACTICE.meeting).is("archived_at", null).limit(5);
  const mvIds = ((mv ?? []) as Row[]).map((m) => m.id);
  if (mvIds.length) {
    const { data: prep } = await db.from("meeting_prep").select("id").eq("workspace_id", ws).in("meeting_visit_id", mvIds).is("archived_at", null).order("created_at").limit(1);
    ids.meeting = (prep?.[0] as Row | undefined)?.id;
  }
  if (ids.contact) {
    const { data: oi } = await db.from("outreach_item").select("id").eq("workspace_id", ws).eq("person_id", ids.contact).is("archived_at", null).order("created_at", { ascending: false }).limit(1);
    ids.outreach = (oi?.[0] as Row | undefined)?.id;
  }
  return ids;
}

/** What practice data exists for the current user's workspace (read-only). */
export async function practiceStatus(): Promise<PracticeStatus> {
  try {
    const ctx = await requireContext("viewer");
    const ids = await find(ctx.db, ctx.workspaceId);
    const core = [ids.company, ids.contact, ids.requirement, ids.opportunity, ids.signal, ids.meeting];
    return { exists: core.some(Boolean), complete: core.every(Boolean), ids, canEdit: hasRole(ctx, "editor") };
  } catch { return { exists: false, complete: false, ids: {}, canEdit: false }; }
}

async function must<T>(p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

/** Ensure every practice record exists. Safe to press twice. */
export async function setupPracticeAction(): Promise<{ ok: boolean; error?: string; ids?: PracticeIds }> {
  try {
    const ctx = await requireContext("editor");
    const { db, workspaceId: ws, userId } = ctx;
    const ids = await find(db, ws);
    const base = { workspace_id: ws, owner_user_id: userId };

    if (!ids.company) ids.company = (await must(db.from("organisation").insert({ ...base, display_name: PRACTICE.company, sector: "Technology", hq_country: "India", account_owner_note: "Tutorial practice record — safe to edit or remove." }).select("id").single()) as Row).id;
    if (!ids.contact) {
      ids.contact = (await must(db.from("person").insert({ ...base, full_name: PRACTICE.contact, preferred_channel: "email", personal_notes: "Tutorial practice contact. The email uses a reserved .example domain and can never receive mail." }).select("id").single()) as Row).id;
    }
    const { data: cm } = await db.from("contact_method").select("id").eq("workspace_id", ws).eq("person_id", ids.contact!).eq("method_type", "email").limit(1);
    if (!(cm ?? []).length) await must(db.from("contact_method").insert({ ...base, person_id: ids.contact, method_type: "email", value: PRACTICE.email, preferred: true }).select("id").single());
    const { data: emp } = await db.from("employment").select("id").eq("workspace_id", ws).eq("person_id", ids.contact!).eq("org_id", ids.company!).limit(1);
    if (!(emp ?? []).length) await must(db.from("employment").insert({ ...base, person_id: ids.contact, org_id: ids.company, title: "Head of Admin", function: "Administration", seniority: "head", is_current: true }).select("id").single());

    if (!ids.requirement) {
      const { data: geo } = await db.from("geography").select("id").eq("workspace_id", ws).ilike("name", "kharadi").is("archived_at", null).limit(1);
      const geoIds = ((geo ?? []) as Row[]).map((g) => g.id);
      ids.requirement = (await must(db.from("requirement").insert({ ...base, org_id: ids.company, title: PRACTICE.requirement, objective: "expansion", transaction_kinds: ["conventional"], area_min_sf: 22000, area_target_sf: 25000, area_max_sf: 28000, area_basis: "chargeable", preferred_geography_ids: geoIds, constraints: { micro_market_text: "Kharadi", note: "Tutorial practice requirement" }, status: "draft" }).select("id").single()) as Row).id;
    }
    if (!ids.opportunity) ids.opportunity = (await must(db.from("opportunity").insert({ ...base, org_id: ids.company, requirement_id: ids.requirement, name: PRACTICE.opportunity, stage: "engaged", temperature: "warm", next_action: "Hold the requirement discussion (tutorial)" }).select("id").single()) as Row).id;
    if (!ids.signal) {
      const day = new Date().toISOString().slice(0, 10);
      ids.signal = (await must(db.from("signal").insert({
        ...base, category: "expansion", kind: "pune_expansion", title: PRACTICE.signal, org_id: ids.company, location_text: "Pune",
        summary: "Practice signal for the tutorials: a made-up report that Practice Co is growing its Pune team.",
        cre_relevance: "If true, they may need more office space in Pune (inference).", verification: "hypothesis", confidence: "low",
        latest_evidence_on: day, status: "new", priority: 60, priority_band: "medium", dedupe_key: `tutorial-practice:${ids.company}`,
      }).select("id").single()) as Row).id;
    }
    if (!ids.meeting) {
      const t = new Date(Date.now() + 864e5);
      const start = new Date(`${t.toISOString().slice(0, 10)}T11:00:00+05:30`).toISOString();
      const r = await createMeeting(db, ws, userId, {
        title: PRACTICE.meeting, start, type: "requirement", location: "Practice Co office, Kharadi (tutorial)",
        purpose: "Practice meeting: confirm area, budget and timing for the Kharadi requirement.",
        orgId: ids.company, opportunityId: ids.opportunity, requirementId: ids.requirement, personIds: [ids.contact!],
      });
      ids.meeting = r.id;
    }
    revalidatePath("/tutorials");
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not set up practice data." };
  }
}

/** Archive every practice record (and outreach prepared for the practice contact). Nothing is hard-deleted. */
export async function removePracticeAction(): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireContext("editor");
    const { db, workspaceId: ws } = ctx;
    const ids = await find(db, ws);
    const at = new Date().toISOString();
    const arch = (table: string, col: string, vals: (string | undefined)[]) => {
      const v = vals.filter(Boolean) as string[];
      return v.length ? db.from(table).update({ archived_at: at }).eq("workspace_id", ws).in(col, v).is("archived_at", null) : Promise.resolve(null);
    };
    let mvId: string | undefined;
    if (ids.meeting) { const { data } = await db.from("meeting_prep").select("meeting_visit_id").eq("id", ids.meeting).limit(1); mvId = (data?.[0] as Row | undefined)?.meeting_visit_id; }
    await Promise.all([
      arch("outreach_item", "person_id", [ids.contact]),
      arch("meeting_prep", "id", [ids.meeting]),
      arch("meeting_visit", "id", [mvId]),
      arch("signal", "id", [ids.signal]),
    ]);
    await arch("opportunity", "id", [ids.opportunity]);
    await arch("requirement", "id", [ids.requirement]);
    await Promise.all([arch("employment", "person_id", [ids.contact]), arch("contact_method", "person_id", [ids.contact])]);
    await arch("person", "id", [ids.contact]);
    await arch("organisation", "id", [ids.company]);
    revalidatePath("/tutorials");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not remove practice data." };
  }
}
