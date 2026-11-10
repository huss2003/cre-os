"use server";
/** Module 8 server actions: brief editing/snapshots/approval and client deliverables. */
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError, must } from "@/modules/deals/ctx";
import { buildPatch, resolveGeographies, updateRequirementFields } from "@/modules/deals/requirements/service";
import { FIELD_BY_KEY, type FieldStatus, type RequirementRow } from "@/modules/deals/requirements/contract";
import { proposeChange } from "@/lib/services/changes";
import { BRIEF_FORMULA, parseFieldInput } from "./brief";
import { generateDeliverables, loadBriefFor } from "./deliverables";
import { approveAnalysis, saveAnalysis } from "./store";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof DealsError || e instanceof Error ? e.message : errorMessage(e) });

/**
 * Edit one brief field. Estimated / Assumption values go through the deals requirement service (which itself turns
 * edits of already-confirmed fields into change proposals). "Confirmed by client" is NEVER written directly: it
 * always becomes a change proposal with the evidence, approved in Review.
 */
export async function updateBriefFieldAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const app = await requireContext("editor");
    const ctx = toDealsCtx(app);
    const id = s(f, "requirement_id"), key = s(f, "key");
    const def = FIELD_BY_KEY.get(key);
    if (!def) throw new Error("Unknown field.");
    const status = (s(f, "status") || "estimated") as FieldStatus;
    if (!["estimated", "reported", "client_confirmed"].includes(status)) throw new Error("Choose Estimated, Assumption or Confirmed.");
    let value = parseFieldInput(key, s(f, "value"));
    if (def.kind === "geo_list") value = await resolveGeographies(ctx, value as string[]);
    if (status === "client_confirmed") {
      const evidence = s(f, "evidence");
      if (!evidence) throw new Error("Say how the client confirmed it (meeting, email reference) — confirmation needs evidence.");
      const req = must(await ctx.db.from("requirement").select("*").eq("id", id).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
      const { columns, constraints } = buildPatch(req, [{ key, value, status: "client_confirmed" }]);
      const patch = [...Object.entries(columns).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })), { op: "replace" as const, path: "/constraints", value: constraints }];
      const before: Record<string, unknown> = {};
      for (const p of patch) before[p.path.slice(1)] = req[p.path.slice(1)] ?? null;
      await proposeChange(ctx.db, ctx.workspaceId, { targetType: "requirement", targetId: id, operation: "update", expectedVersion: Number(req.row_version), patch,
        reason: `Brief: ${def.label} confirmed by client — ${evidence}`, proposedByKind: "user", ownerUserId: ctx.userId, classification: String(req.classification ?? "corporate_confidential"), before });
      revalidatePath(`/toolkit/brief/${id}`);
      return { ok: true, message: `${def.label}: sent for approval as client-confirmed. It shows as confirmed once approved in Review.` };
    }
    const r = await updateRequirementFields(ctx, id, Number(s(f, "row_version")), [{ key, value, status }], `Brief edit: ${def.label}`);
    revalidatePath(`/toolkit/brief/${id}`);
    return { ok: true, message: r.proposals.length ? `${def.label} is already confirmed — your change was sent for approval.` : `${def.label} saved.` };
  } catch (e) { return fail(e); }
}

export async function saveBriefSnapshotAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const app = await requireContext("editor");
    const id = s(f, "requirement_id");
    const brief = await loadBriefFor(app.db, app.workspaceId, id);
    const prior = (await app.db.from("deal_analysis").select("id").eq("workspace_id", app.workspaceId).eq("kind", "brief").eq("requirement_id", id).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data as { id: string } | null;
    const org = (await app.db.from("requirement").select("org_id").eq("id", id).maybeSingle()).data as { org_id: string | null } | null;
    const r = await saveAnalysis(app.db, app.workspaceId, app.userId, {
      id: prior?.id ?? null, kind: "brief", title: `Brief — ${brief.title}`, requirementId: id, orgId: org?.org_id ?? null,
      inputs: { requirementId: id, requirementRowVersion: brief.rowVersion }, outputs: brief, formulaVersion: BRIEF_FORMULA, missing: brief.missing, note: s(f, "note") || null,
    });
    revalidatePath(`/toolkit/brief/${id}`); revalidatePath("/toolkit");
    return { ok: true, message: `Brief snapshot saved (version ${r.version})${brief.missing.length ? ` — ${brief.missing.length} mandatory item(s) still missing, so it cannot be approved yet` : ""}.` };
  } catch (e) { return fail(e); }
}

export async function approveAnalysisAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const app = await requireContext("editor");
    await approveAnalysis(app.db, app.workspaceId, app.userId, s(f, "analysis_id"));
    const back = s(f, "back"); if (back.startsWith("/toolkit")) revalidatePath(back);
    revalidatePath("/toolkit");
    return { ok: true, message: "Approved." };
  } catch (e) { return fail(e); }
}

export async function generateDeliverablesAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const app = await requireContext("editor");
    const requirementId = s(f, "requirement_id");
    if (!requirementId) throw new Error("Choose a requirement.");
    const r = await generateDeliverables(app.db, app.workspaceId, app.userId, { requirementId, analysisIds: f.getAll("analysis_id").map(String).filter(Boolean), preparedFor: s(f, "prepared_for") || null, title: s(f, "title") || null });
    revalidatePath("/toolkit/deliverables"); revalidatePath("/toolkit");
    return { ok: true, message: `3 files generated (version ${r.version}).${r.missing.length ? ` Labelled as incomplete: ${r.missing.join("; ")}.` : ""} Download them from the list below.` };
  } catch (e) { return fail(e); }
}
