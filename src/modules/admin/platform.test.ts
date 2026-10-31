import { describe, it, expect, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient, userClient, USERS, tag } from "../../../tests/helpers";
import { createTenant, setTenantStatus, tenantUsage, listTenants } from "./platform";
import { addMember } from "./members";
import { AdminError } from "./errors";

describe("platform admin tenant onboarding", () => {
  const admin = adminClient();
  const createdWs: string[] = [];
  const createdUsers: string[] = [];
  afterAll(async () => {
    for (const id of createdWs) await admin.from("workspace").delete().eq("id", id);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  });

  it("only platform admins can create tenants", async () => {
    const slug = tag("deny").toLowerCase();
    const err = await createTenant(admin, USERS.other.id, { name: "Nope", slug, ownerEmail: `${slug}@example.test` }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminError);
    expect((err as AdminError).status).toBe(403);
    const { data } = await admin.from("workspace").select("id").eq("slug", slug);
    expect(data).toEqual([]);
    await expect(listTenants(admin, USERS.colleague.id)).rejects.toBeInstanceOf(AdminError);
    // a tenant owner (not platform admin) can't add members to someone else's workspace either
    await expect(addMember(admin, USERS.other.id, "10000000-0000-4000-8000-000000000001", { email: `${slug}@example.test` })).rejects.toBeInstanceOf(AdminError);
  });

  it("creates workspace + first owner (temp password shown once), seeds defaults, and the owner can sign in to only that tenant", async () => {
    const slug = tag("tenant").toLowerCase();
    const email = `${slug}@example.test`;
    const res = await createTenant(admin, USERS.owner.id, { name: `Tenant ${slug}`, slug, ownerEmail: email, ownerName: "New Owner", method: "temp_password" });
    createdWs.push(res.workspace.id);
    createdUsers.push(res.owner.userId);
    expect(res.owner.tempPassword).toBeTruthy();

    const { data: settings } = await admin.from("workspace_setting").select("key, value").eq("workspace_id", res.workspace.id);
    expect(settings?.find((s) => s.key === "size_rules")?.value).toEqual({ min_sf: 5000, max_sf: 200000 });
    const { count } = await admin.from("retention_policy").select("*", { count: "exact", head: true }).eq("workspace_id", res.workspace.id);
    expect(count).toBeGreaterThanOrEqual(6);

    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { error } = await c.auth.signInWithPassword({ email, password: res.owner.tempPassword! });
    expect(error).toBeNull();
    const { data: mine } = await c.from("my_workspaces").select("id, role");
    expect(mine).toEqual([{ id: res.workspace.id, role: "owner" }]);

    const usage = await tenantUsage(admin, USERS.owner.id, res.workspace.id);
    expect(usage.members.length).toBe(1);
    expect(usage.records.organisation).toBe(0);
  });

  it("suspending a tenant also pauses AI; only platform admins may do it", async () => {
    const slug = tag("susp").toLowerCase();
    const res = await createTenant(admin, USERS.owner.id, { name: `Susp ${slug}`, slug, ownerEmail: `${slug}@example.test`, method: "invite_link" });
    createdWs.push(res.workspace.id);
    createdUsers.push(res.owner.userId);
    expect(res.owner.inviteLink).toMatch(/^http/);
    await expect(setTenantStatus(admin, USERS.other.id, res.workspace.id, "suspended")).rejects.toBeInstanceOf(AdminError);
    await setTenantStatus(admin, USERS.owner.id, res.workspace.id, "suspended", "non-payment drill");
    const { data } = await admin.from("workspace").select("status, ai_paused").eq("id", res.workspace.id).single();
    expect(data).toEqual({ status: "suspended", ai_paused: true });
  });

  it("tenant owners cannot see other tenants' workspace rows through RLS", async () => {
    const other = await userClient("other");
    const { data } = await other.from("workspace").select("id");
    expect(data?.map((w) => w.id)).toEqual(["10000000-0000-4000-8000-000000000002"]);
  });
});
