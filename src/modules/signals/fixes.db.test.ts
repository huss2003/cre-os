// Browser-test fixes against the real DB (docs/signal-engine/BROWSER-TEST.md, 2026-11-12).
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag, USERS } from "../../../tests/helpers";
import { actOnSignal, ingestText, listSignals, syncCompletedTasks } from "./service";
import { getSignalCard } from "./card";
import { resolveOrganisation } from "./resolve";
import { localDate } from "@/lib/util/time";

describe("signal engine — browser-test fixes (db)", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  const t = tag("sigfix");
  const word = `Cobaltfern${t.slice(-6)}`;      // distinctive word, unique per run
  const COMPANY = `${word} Systems`;
  let orgId = ""; let sigId = ""; let mm = ""; let loc = "";

  beforeAll(async () => {
    db = await userClient("owner");
    const ins = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
      if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string;
    };
    orgId = await ins("organisation", { display_name: COMPANY });
    await ins("organisation", { display_name: `Marigold${t.slice(-6)} Loop Technologies` });
    mm = `SBD East ${t}`; loc = `Kharadi${t.slice(-6)}`;
    const mmId = await ins("geography", { level: "micro_market", name: mm });
    await ins("geography", { level: "locality", name: loc, parent_id: mmId });
    const r = await ingestText(db, WS1, { text: `${COMPANY} announces expansion of its Pune operations, adding 300 roles in ${loc} from Q1 2027.`, companyName: COMPANY, actorUserId: USERS.owner.id });
    sigId = r.signals[0].id;
  });

  const sig = async (id = sigId) => (await db.from("signal").select("*").eq("workspace_id", WS1).eq("id", id).single()).data!;

  it("#4 #5 #6 event date, micro-market and evidence date come from the text", async () => {
    const s = await sig();
    expect(s.event_date).toBe("2027-01-01");
    expect(s.event_date_basis).toBe("estimated");
    expect(s.micro_market).toBe(mm);
    expect(s.location_text).toContain(loc);
    expect(s.latest_evidence_on).toBe(localDate());
    expect(s.title.startsWith(`${COMPANY}: possible `)).toBe(true);
  });

  it("#5 #6 #7 micro-market, freshness and IST detected-date filters find the pasted signal", async () => {
    // scoped to this test's company: the shared WS1 holds hundreds of same-day signals and the list is capped (sorted) at 200
    const has = async (f: Parameters<typeof listSignals>[2]) => (await listSignals(db, WS1, { orgId, ...f })).some((r) => r.id === sigId);
    expect(await has({ microMarket: loc })).toBe(true);
    expect(await has({ microMarket: mm })).toBe(true);
    expect(await has({ freshDays: 7 })).toBe(true);
    expect(await has({ from: localDate(), to: localDate() })).toBe(true);
    const tomorrow = localDate(new Date(Date.now() + 86_400_000));
    expect(await has({ from: tomorrow })).toBe(false);
  });

  it("#2 pasted counter-evidence naming the company re-assesses its open signal; nothing new is created", async () => {
    const before = await sig();
    const r = await ingestText(db, WS1, { text: `${COMPANY} says its 300 new Pune hires will work remotely and it needs no additional office space.`, actorUserId: USERS.owner.id });
    expect(r.counterFor.map((u) => u.id)).toContain(sigId);
    expect(r.signals.every((x) => !x.created)).toBe(true);
    const after = await sig();
    expect(after.priority).toBeLessThan(before.priority);
    const card = (await getSignalCard(db, WS1, sigId))!;
    expect(card.sections.counterEvidence.some((c) => c.source === "user" && /work remotely/.test(c.text))).toBe(true);
    expect(card.history.some((h) => h.action === "add_counter")).toBe(true);
  });

  it("#3 blank Company field: the name is taken from the text and left unresolved for review", async () => {
    const name = `Quillwave${t.slice(-6)} Robotics`;
    const r = await ingestText(db, WS1, { text: `${name} announces expansion of its Pune operations and will open a new office next year.`, actorUserId: USERS.owner.id });
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.rawName).toBe(name);
    const s = await sig(r.signals[0].id);
    expect(s.org_id).toBeNull();
    expect(s.entity_name_raw).toBe(name);
    expect(s.title.startsWith(`${name}:`)).toBe(true);
    const card = (await getSignalCard(db, WS1, s.id))!;
    expect(card.sections.entity.rawName).toBe(name);
  });

  it("#10 a distinctive shared word outranks a generic one; correcting the company retitles the signal", async () => {
    const res = await resolveOrganisation(db, WS1, { name: `${word} Technologies` });
    expect(res.orgId).toBeNull();
    expect(res.candidates[0]?.id).toBe(orgId);
    const r = await ingestText(db, WS1, { text: `${word} Technologies announces it is hiring 150 engineers in Pune.`, companyName: `${word} Technologies`, actorUserId: USERS.owner.id });
    const id = r.signals[0].id;
    expect((await sig(id)).title.startsWith(`${word} Technologies:`)).toBe(true);
    await actOnSignal(db, WS1, USERS.owner.id, id, "correct_company", { org_id: orgId });
    expect((await sig(id)).title.startsWith(`${COMPANY}:`)).toBe(true);
    const h = (await getSignalCard(db, WS1, id))!.history.find((x) => x.action === "correct_company")!;
    expect(h.data).toMatchObject({ from_name: `${word} Technologies`, to_name: COMPANY });
  });

  it("#11 #1 approve creates a short task; completing it in /tasks is written back to the signal history", async () => {
    await actOnSignal(db, WS1, USERS.owner.id, sigId, "approve");
    const s = await sig();
    const { data: task } = await db.from("task").select("*").eq("workspace_id", WS1).eq("id", s.task_id).single();
    expect(task!.title.length).toBeLessThanOrEqual(80);
    expect(task!.title).not.toMatch(/On record/);
    expect(task!.description).toMatch(/Recommended:/);
    expect(task!.related_entities).toEqual(expect.arrayContaining([{ type: "signal", id: sigId }]));
    expect((await getSignalCard(db, WS1, sigId))!.actions).toContain("record_outcome");

    // Completed from /tasks (not via the signal page).
    await db.from("task").update({ status: "done", completion_evidence: `Spoke to facilities ${t}`, completed_at: new Date().toISOString() }).eq("workspace_id", WS1).eq("id", s.task_id);
    const card = (await getSignalCard(db, WS1, sigId))!;
    const ev = card.history.filter((h) => h.action === "task_completed");
    expect(ev).toHaveLength(1);
    expect((ev[0].data as Record<string, unknown>).outcome).toBe(`Spoke to facilities ${t}`);
    expect(card.header.status).toBe("converted");
    expect(card.actions).not.toContain("record_outcome");
    expect(await syncCompletedTasks(db, WS1, [sigId])).toBe(0);   // idempotent
  });
});
