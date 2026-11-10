/** Integration: brief snapshot + deliverable generation as a signed-in user (RLS), files stored and downloadable. */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, tag, userClient } from "../../../tests/helpers";
import type { Db } from "@/lib/supabase/server";
import { createRequirement } from "@/modules/deals/requirements/service";
import { downloadDeliverable, generateDeliverables, loadBriefFor } from "./deliverables";
import { BRIEF_FORMULA } from "./brief";
import { approveAnalysis, getAnalysis, saveAnalysis } from "./store";

let db: Db; let reqId: string;
beforeAll(async () => {
  db = await userClient("owner");
  const r = await createRequirement({ db, workspaceId: WS1, userId: USERS.owner.id, role: "owner" }, { orgName: tag("Toolkit Co"), title: tag("Toolkit req"), changes: [{ key: "objective", value: "relocation" }, { key: "area", value: [5000, 6000, 7000] }] });
  reqId = String(r.id);
});

describe("toolkit brief + deliverables (db)", () => {
  it("saves a brief snapshot as versioned analysis; missing info blocks approval", async () => {
    const brief = await loadBriefFor(db, WS1, reqId);
    expect(brief.sections.flatMap((s) => s.fields).find((f) => f.key === "objective")!.status).toBe("Estimated");
    const s1 = await saveAnalysis(db, WS1, USERS.owner.id, { kind: "brief", title: "Brief", requirementId: reqId, inputs: { requirementRowVersion: brief.rowVersion }, outputs: brief, formulaVersion: BRIEF_FORMULA, missing: brief.missing });
    const s2 = await saveAnalysis(db, WS1, USERS.owner.id, { id: s1.id, kind: "brief", title: "Brief", requirementId: reqId, inputs: { requirementRowVersion: brief.rowVersion }, outputs: brief, formulaVersion: BRIEF_FORMULA, missing: brief.missing });
    expect(s2).toEqual({ id: s1.id, version: 2 });
    const a = await getAnalysis(db, WS1, s1.id);
    expect((a as Record<string, unknown>).status).toBe("needs_info");
    await expect(approveAnalysis(db, WS1, USERS.owner.id, s1.id)).rejects.toThrow(/missing/i);
  });
  it("generates 3 files, records analysis versions used, labels incomplete inputs, downloads with hash check", async () => {
    const lease = await saveAnalysis(db, WS1, USERS.owner.id, { kind: "lease_economics", title: tag("Lease"), requirementId: reqId, inputs: { rent: 90 }, outputs: { total: 100 }, formulaVersion: "lease-1.0", missing: ["escalation"] });
    const r = await generateDeliverables(db, WS1, USERS.owner.id, { requirementId: reqId, analysisIds: [lease.id], preparedFor: "CFO" });
    expect(r.files.map((f) => f.name)).toEqual(["proposal.docx", "analysis-workbook.xlsx", "decision-summary.docx"]);
    expect(r.missing.some((m) => m.includes("needs info"))).toBe(true);
    const d = await getAnalysis(db, WS1, r.id) as Record<string, any>;
    expect(d.kind).toBe("deliverable");
    expect(d.formula_version).toBe("deliverable-1.0");
    expect(d.inputs.analyses[0]).toMatchObject({ id: lease.id, version: 1, formula_version: "lease-1.0" });
    const f = await downloadDeliverable(db, WS1, r.id, "analysis-workbook.xlsx");
    expect(f.buffer.subarray(0, 2).toString()).toBe("PK");
    await expect(downloadDeliverable(db, WS1, r.id, "../evil.docx")).rejects.toThrow();
  });
  it("other workspace users cannot read the deliverable", async () => {
    const other = await userClient("other");
    const r = (await db.from("deal_analysis").select("id").eq("workspace_id", WS1).eq("kind", "deliverable").eq("requirement_id", reqId).limit(1).single()).data as { id: string };
    await expect(downloadDeliverable(other, WS1, r.id, "proposal.docx")).rejects.toThrow();
  });
});
