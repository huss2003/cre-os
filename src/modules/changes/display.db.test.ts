import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, userClient, USERS, WS1, WS2 } from "../../../tests/helpers";
import { collectRefs, formatValue, proposalRefs, resolveRefs, UNKNOWN_RECORD } from "./display";

const admin = adminClient();
const made: [string, string][] = [];
let org = "", geo = "", asset = "", lease = "", space = "", foreign = "";

beforeAll(async () => {
  const ins = async (t: string, row: Record<string, unknown>) => {
    const { data, error } = await admin.from(t).insert({ owner_user_id: USERS.owner.id, ...row }).select("id").single();
    if (error) throw error; made.push([t, data!.id]); return data!.id as string;
  };
  org = await ins("organisation", { workspace_id: WS1, display_name: tag("Acme") });
  foreign = await ins("organisation", { workspace_id: WS2, display_name: tag("Other WS Co") });
  const { data: g } = await admin.from("geography").select("id, name").eq("workspace_id", WS1).limit(1);
  geo = g?.[0]?.id ?? "";
  asset = await ins("asset", { workspace_id: WS1, name: tag("Tower A") });
  lease = await ins("lease", { workspace_id: WS1, tenant_org_id: org, asset_id: asset });
  space = await ins("space", { workspace_id: WS1, asset_id: asset, floor_text: "5", unit: "501" });
});
afterAll(async () => { for (const [t, id] of made.reverse()) await admin.from(t).delete().eq("id", id); });

describe("proposal id resolution (RLS + workspace filter)", () => {
  it("resolves names for a workflow-chain style proposal; foreign/unknown ids stay Unknown record", async () => {
    const db = await userClient("owner");
    const patch = [
      { path: "/org_id", value: org }, { path: "/preferred_geography_ids", value: [geo, foreign].filter(Boolean) },
      { path: "/constraints", value: { lease_id: lease, space_id: space, other_org_id: foreign } },
    ];
    const refs = await proposalRefs(db, WS1, [{ patch }]);
    expect(refs[org]).toMatch(/^Acme/);
    expect(refs[lease]).toMatch(/^Acme.* at Tower A/);
    expect(refs[space]).toMatch(/^Tower A.*, floor 5, unit 501$/);
    expect(refs[foreign]).toBeUndefined();          // other workspace never resolves
    expect(formatValue("/constraints", patch[2].value, refs)).toContain(`Other org: ${UNKNOWN_RECORD}`);
    expect(formatValue("/constraints", patch[2].value, refs)).not.toContain(foreign);
  });
  it("a user outside the workspace gets nothing (RLS)", async () => {
    const other = await userClient("other");
    const refs = await resolveRefs(other, WS1, collectRefs("/org_id", org));
    expect(refs[org]).toBeUndefined();
  });
});
