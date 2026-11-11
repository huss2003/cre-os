import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import { analyseNotes, approveNotes, type NoteCtx } from "./service";

const NOW = new Date("2026-11-11T05:00:00Z"); // Wed 11 Nov 2026, 10:30 IST

describe("notes → database updates (mock extraction)", () => {
  let c: NoteCtx; const t = tag("notes");
  const orgName = `Kestrel Notes ${t}`, personName = `Priya Notes${t.slice(-4)}`;
  let orgId = "", reqId = "", personId = "";
  beforeAll(async () => {
    const admin = adminClient();
    const own = { workspace_id: WS1, owner_user_id: USERS.owner.id };
    orgId = (await admin.from("organisation").insert({ ...own, display_name: orgName }).select("id").single()).data!.id;
    personId = (await admin.from("person").insert({ ...own, full_name: personName }).select("id").single()).data!.id;
    await admin.from("employment").insert({ ...own, person_id: personId, org_id: orgId, title: "CFO" });
    reqId = (await admin.from("requirement").insert({ ...own, org_id: orgId, title: `Req ${t}`, seats_target: 150 }).select("id").single()).data!.id;
    c = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, timezone: "Asia/Kolkata" };
  });

  it("proposes changes, writes nothing before approval, dedupes, keeps unknowns unknown, applies selection", async () => {
    const text = `Met ${personName} at ${orgName}. They now need 220 seats. ${personName} is the finance head. Send shortlist tomorrow. Concern: too expensive. Also spoke to Rahul Unknownperson${t.slice(-3)}.`;
    const { note, duplicate } = await analyseNotes(c, { text, orgId }, { now: NOW });
    expect(duplicate).toBe(false);
    const seats = note.proposals.find((p) => p.kind === "requirement_field" && p.payload.field === "seats_target");
    expect(seats).toBeTruthy();
    expect(seats!.before).toBe(150); expect(seats!.after).toBe(220); expect(seats!.material).toBe(true);
    const task = note.proposals.find((p) => p.kind === "task");
    expect(task).toBeTruthy();
    expect(task!.payload.dueAt).toBe("2026-11-12T12:30:00.000Z"); // 18:00 IST resolved by code
    expect(note.proposals.some((p) => p.label === "Objection")).toBe(true);
    // unknown person is not invented
    expect(note.unresolved.join(" ")).toMatch(/not in your records|not linked/);
    expect(JSON.stringify(note.proposals)).not.toMatch(/Unknownperson/);

    // nothing written yet
    const admin = adminClient();
    expect((await admin.from("change_proposal").select("id").eq("workspace_id", WS1).eq("target_id", reqId)).data).toHaveLength(0);
    expect((await admin.from("task").select("id").eq("workspace_id", WS1).like("idempotency_key", `assistant_note:${note.id}%`)).data).toHaveLength(0);
    expect((await admin.from("interaction").select("id").eq("workspace_id", WS1).eq("source_message_id", `assistant_note:${note.id}`)).data).toHaveLength(0);
    expect((await admin.from("requirement").select("seats_target").eq("id", reqId).single()).data!.seats_target).toBe(150);

    // re-submit → same note
    const again = await analyseNotes(c, { text, orgId }, { now: NOW });
    expect(again.duplicate).toBe(true); expect(again.note.id).toBe(note.id);

    // approve seats + task only; objection discarded
    const r = await approveNotes(c, note.id, [seats!.id, task!.id], { now: NOW });
    expect(r.results.errors).toEqual({});
    expect(r.results.rejected).toContain(note.proposals.find((p) => p.label === "Objection")!.id);
    const cps = (await admin.from("change_proposal").select("id, state, patch").eq("workspace_id", WS1).eq("target_id", reqId)).data!;
    expect(cps).toHaveLength(1); expect(cps[0].state).toBe("proposed");
    expect((await admin.from("requirement").select("seats_target").eq("id", reqId).single()).data!.seats_target).toBe(150); // still needs approval
    expect((await admin.from("task").select("id").eq("workspace_id", WS1).like("idempotency_key", `assistant_note:${note.id}%`)).data).toHaveLength(1);
    const ix = (await admin.from("interaction").select("id").eq("workspace_id", WS1).eq("source_message_id", `assistant_note:${note.id}`)).data!;
    expect(ix).toHaveLength(1);
    const links = (await admin.from("interaction_link").select("entity_id").eq("interaction_id", ix[0].id)).data!.map((l) => l.entity_id);
    expect(links).toEqual(expect.arrayContaining([orgId, reqId]));
    expect((await admin.from("assistant_memory").select("id").eq("workspace_id", WS1).eq("source", `note:${note.id}`)).data).toHaveLength(0);

    // approving twice is idempotent
    const r2 = await approveNotes(c, note.id, [seats!.id, task!.id], { now: NOW });
    expect(r2.duplicate).toBe(true);
    expect((await admin.from("change_proposal").select("id").eq("workspace_id", WS1).eq("target_id", reqId)).data).toHaveLength(1);
  });

  it("ambiguous numbers/dates stay unknown", async () => {
    const { note } = await analyseNotes(c, { text: `${orgName}: maybe fifty seats, decision by March.`, orgId }, { now: NOW });
    expect(note.proposals.some((p) => p.payload.field === "seats_target" || p.payload.field === "decision_date")).toBe(false);
    expect(note.unresolved.join(" ")).toMatch(/left unknown/);
  });
});
