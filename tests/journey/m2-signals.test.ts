// Journey test plan — STAGE 2: Module 2 Signal Engine (TC 2.1–2.7). Synthetic ABC Technologies, WS1 owner, mock-AI (rules only).
// Real services the /signals UI calls: signals/service ingestText (paste evidence), scanWorkspace (Scan now), signalDetail, listSignals.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, USERS, tag } from "../helpers";
import { createEntity } from "@/modules/admin/entities";
import { ingestText, scanWorkspace, signalDetail, listSignals } from "@/modules/signals/service";

const log = (id: string, actual: unknown) => console.log(`[ACTUAL ${id}]`, JSON.stringify(actual));

describe("Journey M2 — Signal Engine", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  const owner = USERS.owner.id;
  const t = tag("j2");
  const ABC = `ABC Technologies Pvt. Ltd. ${t}`;
  const ids: Record<string, string> = {};
  const one = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: owner, ...row }).select("id").single();
    if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string;
  };

  beforeAll(async () => {
    db = await userClient("owner");
    ids.org = (await createEntity(db, WS1, owner, "organisation", { display_name: ABC, sector: "Information Technology" })).id;
    ids.loc = await one("geography", { name: `Kharadi ${t}`, level: "locality" });
    ids.asset = await one("asset", { name: `ABC Kharadi Office ${t}`, locality_id: ids.loc, address: "Kharadi, Pune" });
    ids.lease = await one("lease", { tenant_org_id: ids.org, asset_id: ids.asset, area_sf: 15000, fact_status: "reported" });
    ids.rahul = await one("person", { full_name: `Rahul Sharma ${t}` });
    await one("employment", { person_id: ids.rahul, org_id: ids.org, title: "Head of Administration", is_current: true });
  });

  it("TC2.1 expansion signal: matched to ABC, Pune, date+source, explains office relevance", async () => {
    const r = await ingestText(db, WS1, { text: `${ABC} announces expansion of its Pune operations.`, companyName: ABC, sourceName: "Synthetic press release", sourceUrl: `https://example.test/${t}/pr`, publishedOn: "2026-11-05", actorUserId: owner });
    const det = await Promise.all(r.signals.map((s) => signalDetail(db, WS1, s.id)));
    const exp = det.find((d) => d!.signal.category === "expansion" && d!.signal.kind === "expansion")!;
    ids.exp = exp?.signal.id;
    log("2.1", { kinds: det.map((d) => d!.signal.kind), org: exp?.signal.org_id, location: exp?.signal.location_text, latest: exp?.signal.latest_evidence_on, event_date: exp?.signal.event_date, evidence: exp?.evidence.map((e) => [e.source_name, e.published_on]), relevance: exp?.signal.cre_relevance });
    expect(exp).toBeTruthy();
    expect(exp.signal.org_id).toBe(ids.org);
    expect(String(exp.signal.location_text)).toMatch(/Pune/);
    expect(exp.evidence[0].source_name).toBe("Synthetic press release");
    expect(String(exp.evidence[0].published_on ?? exp.signal.latest_evidence_on)).toBe("2026-11-05");
    expect(String(exp.signal.cre_relevance ?? "")).toMatch(/office|space|requirement|occup/i);
  });

  it("TC2.2 hiring signal: linked to ABC, Pune, location check, not concluded as office need", async () => {
    const r = await ingestText(db, WS1, { text: `${ABC} is recruiting 100 additional employees for its Pune operations.`, companyName: ABC, sourceName: "Synthetic jobs article", publishedOn: "2026-11-06", actorUserId: owner });
    const det = await Promise.all(r.signals.map((s) => signalDetail(db, WS1, s.id)));
    const h = det.find((d) => d!.signal.kind === "hiring")!;
    ids.hiring = h?.signal.id;
    const blob = JSON.stringify(h?.signal ?? {});
    log("2.2", { kinds: det.map((d) => d!.signal.kind), org: h?.signal.org_id, location: h?.signal.location_text, verification: h?.signal.verification, summary: h?.signal.summary, missing: h?.signal.missing_info, action: h?.signal.recommended_action });
    expect(h).toBeTruthy();
    expect(h.signal.org_id).toBe(ids.org);
    expect(String(h.signal.location_text)).toMatch(/Pune/);
    expect(h.signal.verification).not.toBe("fact");
    expect(blob).toMatch(/not an office-size commitment|not a commitment|Hiring is a demand signal/i);
    expect(blob).toMatch(/hiring location|Pune-based|where .* roles|location/i);
  });

  it("TC2.3 lease expiry (text): identified as CRE trigger and linked to occupancy", async () => {
    const r = await ingestText(db, WS1, { text: `${ABC}'s existing Pune lease is due to expire within 12 months.`, companyName: ABC, sourceName: "Synthetic broker note", publishedOn: "2026-11-07", actorUserId: owner });
    const det = await Promise.all(r.signals.map((s) => signalDetail(db, WS1, s.id)));
    log("2.3-text", { detected: r.detected, kinds: det.map((d) => d!.signal.kind), leaseLinked: det.map((d) => d!.signal.lease_id) });
    expect.soft(det.some((d) => d!.signal.category === "lease"), "pasted lease-expiry text is not detected as a lease signal").toBe(true);
    expect.soft(det.some((d) => d!.signal.lease_id === ids.lease), "signal not linked to the occupancy (lease) record").toBe(true);
  });

  it("TC2.3 lease expiry (structured lease date): scan creates prioritised renewal/relocation signal linked to lease", async () => {
    const in300 = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
    ids.ev = await one("lease_event", { lease_id: ids.lease, event_type: "expiry", event_date: in300, date_basis: "reported", confirmed: false });
    await scanWorkspace(db, WS1);
    const rows = (await listSignals(db, WS1, { view: "lease", q: ABC })).filter((s) => s.lease_event_id === ids.ev);
    const d = rows[0] ? (await signalDetail(db, WS1, rows[0].id))! : null;
    log("2.3-scan", { n: rows.length, kind: d?.signal.kind, lease: d?.signal.lease_id, priority: d?.signal.priority, band: d?.signal.priority_band, reasons: d?.signal.priority_reasons, action: d?.signal.recommended_action });
    expect(rows).toHaveLength(1);
    expect(d!.signal.lease_id).toBe(ids.lease);
    expect(d!.signal.priority_reasons.join(" ")).toMatch(/Event in \d+ days/);
    expect(String(d!.signal.recommended_action) + String(d!.signal.cre_relevance)).toMatch(/renew|relocat/i);
  });

  it("TC2.4 leadership change: detected, person attempted only when supported, role relevance", async () => {
    const r = await ingestText(db, WS1, { text: `${ABC} appoints a new Head of Administration.`, companyName: ABC, sourceName: "Synthetic HR news", publishedOn: "2026-11-08", actorUserId: owner });
    const det = await Promise.all(r.signals.map((s) => signalDetail(db, WS1, s.id)));
    const l = det.find((d) => d!.signal.category === "leadership")!;
    log("2.4", { kinds: det.map((d) => d!.signal.kind), person: l?.signal.person_id, relevance: l?.signal.cre_relevance, missing: l?.signal.missing_info, action: l?.signal.recommended_action });
    expect(l).toBeTruthy();
    expect(l.signal.org_id).toBe(ids.org);
    // unnamed appointee: must NOT be attached to existing Rahul Sharma (insufficient support)
    expect(l.signal.person_id).not.toBe(ids.rahul);
    expect(JSON.stringify(l.signal)).toMatch(/admin|facilit|real estate|decision/i);
  });

  it("TC2.5 three articles of one expansion -> one signal, three sources retained", async () => {
    const texts = [
      [`${ABC} announces expansion of its Pune operations, adding a second office.`, "Synthetic Daily"],
      [`Report: ${ABC} plans expansion in Pune with additional office space.`, "Synthetic Business Wire"],
      [`${ABC} confirms Pune expansion of operations at its investor call.`, "Synthetic Tech Times"],
    ];
    const ids2: string[] = [];
    for (const [i, [text, src]] of texts.entries()) {
      const r = await ingestText(db, WS1, { text, companyName: ABC, sourceName: src, sourceUrl: `https://example.test/${t}/a${i}`, publishedOn: `2026-11-1${i}`, actorUserId: owner });
      ids2.push(...r.signals.filter((s) => s).map((s) => s.id));
    }
    const exp = (await listSignals(db, WS1, { q: ABC })).filter((s) => s.org_id === ids.org && s.kind === "expansion");
    const d = (await signalDetail(db, WS1, exp[0].id))!;
    const sources = new Set(d.evidence.map((e) => e.source_name));
    log("2.5", { expansionSignals: exp.length, evidence: d.evidence.length, sources: [...sources], confidenceReasons: d.signal.confidence_reasons });
    expect(exp).toHaveLength(1);
    expect(sources.size).toBeGreaterThanOrEqual(3);
  });

  it("TC2.6 counter-evidence (remote outside Pune) lowers confidence and is explained", async () => {
    const org2 = (await createEntity(db, WS1, owner, "organisation", { display_name: `ABC Remote Check ${t}` })).id; // isolated so 2.2 signal isn't reused
    const r = await ingestText(db, WS1, { text: `ABC Remote Check ${t} has announced hiring, but the majority of new employees will work remotely outside Pune.`, orgId: org2, companyName: `ABC Remote Check ${t}`, sourceName: "Synthetic memo", publishedOn: "2026-11-09", actorUserId: owner });
    const det = await Promise.all(r.signals.map((s) => signalDetail(db, WS1, s.id)));
    const h = det.find((d) => d!.signal.kind === "hiring")!;
    const blob = JSON.stringify({ s: h?.signal, e: h?.evidence });
    log("2.6", { kinds: det.map((d) => d!.signal.kind), confidence: h?.signal.confidence, reasons: h?.signal.confidence_reasons, band: h?.signal.priority_band, verification: h?.signal.verification, counterRows: h?.evidence.filter((e) => e.role === "counter").length, mentionsRemote: /remote/i.test(blob), counters: h?.signal.context_json?.counter_evidence, counterText: /Evidence mentions remote work|may not need office space/i.test(blob), location: h?.signal.location_text, missing: h?.signal.missing_info });
    expect(h).toBeTruthy();
    expect(blob, "counter-evidence explanation for remote work").toMatch(/Evidence mentions remote work|may not need office space/i);
    expect(["low", "insufficient"]).toContain(h.signal.confidence);
    expect(h.signal.verification).not.toBe("fact");
    expect.soft(h.signal.priority_band, "remote-hiring should not be high priority demand").not.toBe("high");
  });

  it("TC2.7 signal card has: what/company/location/why/evidence/observed/unknown/next action", async () => {
    const d = (await signalDetail(db, WS1, ids.exp))!;
    const s = d.signal;
    const card = { what: s.summary ?? s.title, company: s.org?.display_name, location: s.location_text, why: s.cre_relevance, evidence: d.evidence.length, observed: s.detected_at ?? s.latest_evidence_on, unknown: s.missing_info, next: s.recommended_action };
    log("2.7", card);
    expect(card.what).toBeTruthy();
    expect(card.company).toBe(ABC);
    expect(card.location).toMatch(/Pune/);
    expect(card.why).toBeTruthy();
    expect(card.evidence).toBeGreaterThan(0);
    expect(card.observed).toBeTruthy();
    expect(card.unknown.length).toBeGreaterThan(0);
    expect(card.next).toBeTruthy();
  });
});
