// Module 2 end-to-end (spec §19): announcement -> resolve company -> context -> signal -> approve -> task, idempotent, isolated.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, WS2, tag, USERS } from "../../../tests/helpers";
import { ingestText, scanWorkspace, actOnSignal, listSignals, signalDetail, resolveOrg } from "./service";

describe("Module 2 — signal engine", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  let owner: string;
  const t = tag("sig");
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    db = await userClient("owner");
    owner = (await db.auth.getUser()).data.user!.id;
    const one = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
      if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string;
    };
    ids.org = await one("organisation", { display_name: `Zeta ${t}` });
    ids.loc = await one("geography", { name: `Kharadi ${t}`, level: "locality" });
    ids.asset = await one("asset", { name: `Tower ${t}`, locality_id: ids.loc });
    ids.lease = await one("lease", { tenant_org_id: ids.org, asset_id: ids.asset, area_sf: 20000, contractual_expiry: "2027-12-31" });
    const in60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    ids.ev = await one("lease_event", { lease_id: ids.lease, event_type: "notice_deadline", event_date: in60, date_basis: "contractual", confirmed: true });
    ids.person = await one("person", { full_name: `Asha ${t}` });
    await one("employment", { person_id: ids.person, org_id: ids.org, title: "Head of Facilities", is_current: true });
  });

  it("resolves exact names only; fuzzy stays a suggestion", async () => {
    expect((await resolveOrg(db, WS1, `zeta ${t}`)).orgId).toBe(ids.org);
    expect((await resolveOrg(db, WS1, `Zeta`)).orgId).toBeNull();
  });

  it("announcement -> signal with context, counter-evidence, next action; re-ingest does not duplicate", async () => {
    const text = `Zeta ${t} announced it is expanding its Pune operations and will open a new office in Kharadi next year.`;
    const r1 = await ingestText(db, WS1, { text, companyName: `Zeta ${t}`, sourceName: "Press release", sourceUrl: `https://example.com/${t}`, publishedOn: "2026-11-02" });
    expect(r1.signals.length).toBeGreaterThan(0);
    const r2 = await ingestText(db, WS1, { text, companyName: `Zeta ${t}`, sourceName: "Press release", sourceUrl: `https://example.com/${t}`, publishedOn: "2026-11-02" });
    expect(r2.signals.every((s) => !s.created)).toBe(true);
    const d = (await signalDetail(db, WS1, r1.signals[0].id))!;
    expect(d.signal.org_id).toBe(ids.org);
    expect(d.signal.verification).toBe("hypothesis");
    expect(d.signal.context_json.contacts[0].title).toBe("Head of Facilities");
    expect(d.signal.recommended_action).toMatch(/Asha/);
    expect(d.signal.missing_info.join(" ")).toMatch(/not inferred/);
    expect(d.evidence).toHaveLength(1);
    ids.sig = d.signal.id;
  });

  it("lease scan creates a distinct notice-deadline signal, idempotently", async () => {
    await scanWorkspace(db, WS1);
    await scanWorkspace(db, WS1);
    const rows = (await listSignals(db, WS1, { view: "lease", q: `Zeta ${t}` })).filter((r) => r.lease_event_id === ids.ev);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("lease_notice_deadline");
    expect(rows[0].verification).toBe("fact");
  });

  it("approve creates exactly one task in the task system; history kept", async () => {
    await actOnSignal(db, WS1, owner, ids.sig, "approve");
    await actOnSignal(db, WS1, owner, ids.sig, "create_task");
    const { data: tasks } = await db.from("task").select("id, linked_entity_id, source").eq("workspace_id", WS1).eq("idempotency_key", `signal:${ids.sig}`);
    expect(tasks).toHaveLength(1); expect(tasks![0].linked_entity_id).toBe(ids.org);
    const d = (await signalDetail(db, WS1, ids.sig))!;
    expect(d.signal.status).toBe("converted"); expect(d.history.map((h) => h.action)).toContain("approve");
  });

  it("dismiss needs a reason; snooze needs a date; override is recorded with reason", async () => {
    await expect(actOnSignal(db, WS1, owner, ids.sig, "dismiss")).rejects.toThrow(/reason/);
    await expect(actOnSignal(db, WS1, owner, ids.sig, "snooze", {})).rejects.toThrow(/date/);
    await actOnSignal(db, WS1, owner, ids.sig, "override_priority", { band: "high", reason: "CEO told us directly" });
    const d = (await signalDetail(db, WS1, ids.sig))!;
    expect(d.signal.priority_band).toBe("high"); expect(d.signal.priority_override.reason).toBe("CEO told us directly");
  });

  it("other workspace cannot see the signal", async () => {
    const other = await userClient("other");
    const { data } = await other.from("signal").select("id").eq("id", ids.sig);
    expect(data ?? []).toHaveLength(0);
    expect(WS2).not.toBe(WS1); void USERS;
  });
});
