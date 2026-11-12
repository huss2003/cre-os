// Signals UI action handlers against the real DB: persisted, role-checked, idempotent, workspace-isolated.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag, USERS } from "../../../tests/helpers";
import { actOnSignal, ingestText } from "./service";
import { runSignalForm, lookupOpportunities, FormProblem } from "./ui-data";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("signals UI actions (db)", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  let other: Awaited<ReturnType<typeof userClient>>;
  const t = tag("sigui");
  let sigId = ""; let orgId = ""; let org2 = ""; let oppId = "";
  const ed = () => ({ db, workspaceId: WS1, userId: USERS.owner.id, role: "editor" });
  const run = (form: Record<string, string>) => runSignalForm(ed(), sigId, fd(form), actOnSignal as never);
  const sig = async () => (await db.from("signal").select("*").eq("workspace_id", WS1).eq("id", sigId).single()).data!;

  beforeAll(async () => {
    db = await userClient("owner");
    other = await userClient("other");
    const ins = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
      if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string;
    };
    orgId = await ins("organisation", { display_name: `Ulta ${t}` });
    org2 = await ins("organisation", { display_name: `Ulta Two ${t}` });
    oppId = await ins("opportunity", { org_id: orgId, name: `Deal ${t}` });
    const r = await ingestText(db, WS1, { text: `Ulta ${t} announced it is expanding its Pune operations and will open a new office in Kharadi next year.`, companyName: `Ulta ${t}`, sourceName: "Press", sourceUrl: `https://example.com/${t}`, publishedOn: "2026-11-01" });
    sigId = r.signals[0].id;
  });

  it("viewer role cannot change a signal (nothing persisted)", async () => {
    const before = await sig();
    await expect(runSignalForm({ ...ed(), role: "viewer" }, sigId, fd({ action: "approve" }), actOnSignal as never)).rejects.toBeInstanceOf(FormProblem);
    expect((await sig()).row_version).toBe(before.row_version);
  });

  it("investigate, assign, dismiss with reason, reopen — all persisted with history", async () => {
    await run({ action: "investigate" }); expect((await sig()).status).toBe("reviewing");
    await run({ action: "assign_me" }); expect((await sig()).assigned_user_id).toBe(USERS.owner.id);
    await run({ action: "dismiss", reason: `not relevant ${t}` });
    const s = await sig(); expect(s.status).toBe("dismissed"); expect(s.status_reason).toBe(`not relevant ${t}`);
    await run({ action: "reopen" }); expect((await sig()).status).toBe("new");
    const { data: h } = await db.from("signal_review").select("action").eq("signal_id", sigId);
    expect((h ?? []).map((x) => x.action)).toEqual(expect.arrayContaining(["investigate", "assign_me", "dismiss", "reopen"]));
  });

  it("snooze requires a future date", async () => {
    await expect(run({ action: "snooze", until: "2000-01-01" })).rejects.toThrow();
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await run({ action: "snooze", until, reason: "after budget" });
    const s = await sig(); expect(s.status).toBe("snoozed"); expect(s.snoozed_until).toBe(until);
    await run({ action: "reopen" });
  });

  it("create task is idempotent (one task per signal)", async () => {
    await run({ action: "create_task", title: `Call ${t}` });
    await run({ action: "create_task", title: `Call ${t}` });
    const { data } = await db.from("task").select("id").eq("workspace_id", WS1).eq("idempotency_key", `signal:${sigId}`);
    expect(data!.length).toBe(1);
    expect((await sig()).task_id).toBe(data![0].id);
  });

  it("links an opportunity found through the picker lookup", async () => {
    const items = await lookupOpportunities(db, WS1, `Deal ${t}`);
    expect(items.map((i) => i.id)).toContain(oppId);
    expect(await lookupOpportunities(other, WS1, `Deal ${t}`)).toEqual([]);   // other workspace sees nothing
    await run({ action: "link_opportunity", opportunity_id: oppId });
    expect((await sig()).opportunity_id).toBe(oppId);
  });

  it("propose opportunity goes to Review once (idempotent proposal)", async () => {
    await run({ action: "propose_opportunity", name: `Proposed ${t}` });
    await run({ action: "propose_opportunity", name: `Proposed ${t}` });
    const { data } = await db.from("change_proposal").select("id").eq("workspace_id", WS1).eq("idempotency_key", `signals.opportunity:${sigId}`);
    expect(data!.length).toBe(1);
  });

  it("evidence: http(s) only; supporting + counter persisted", async () => {
    await expect(run({ action: "add_evidence", text: "Something", url: "javascript:alert(1)" })).rejects.toBeInstanceOf(FormProblem);
    await run({ action: "add_evidence", text: `Second source ${t}`, source: "Mint", url: "https://livemint.com/x" });
    await run({ action: "add_counter", text: `Company denied it ${t}` });
    const { data } = await db.from("signal_evidence").select("role, excerpt").eq("signal_id", sigId);
    expect(data!.some((e) => e.role === "support" && e.excerpt === `Second source ${t}`)).toBe(true);
    expect(data!.some((e) => e.role === "counter")).toBe(true);
  });

  it("correct company + priority override with reason/review date are persisted and logged", async () => {
    await run({ action: "correct_company", org_id: org2 });
    expect((await sig()).org_id).toBe(org2);
    await expect(run({ action: "override_priority", band: "high" })).rejects.toThrow(/reason/);
    const review = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await run({ action: "override_priority", band: "high", reason: `key account ${t}`, review_on: review });
    const s = await sig(); expect(s.priority_band).toBe("high"); expect(s.priority_override.review_on).toBe(review);
    const { data: h } = await db.from("signal_review").select("action, data").eq("signal_id", sigId).eq("action", "correct_company");
    expect(h![0].data.from_org_id).toBe(orgId);
  });

  it("mark as already known, then approve creates no second task", async () => {
    await run({ action: "known" }); expect((await sig()).status).toBe("known");
    await run({ action: "reopen" });
    await run({ action: "approve" });
    expect((await sig()).status).toBe("converted");
    const { data } = await db.from("task").select("id").eq("idempotency_key", `signal:${sigId}`);
    expect(data!.length).toBe(1);
  });

  it("another workspace cannot act on the signal", async () => {
    await expect(runSignalForm({ db: other, workspaceId: WS1, userId: USERS.other.id, role: "owner" }, sigId, fd({ action: "investigate" }), actOnSignal as never)).rejects.toThrow();
  });
});
