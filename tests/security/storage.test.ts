/**
 * Storage isolation for the private `workspace-files` bucket (path prefix = workspace id).
 * Spec "Permissions": a colleague cannot retrieve another restricted account through a direct object URL.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { userClient, adminClient, WS1, WS2, tag } from "../helpers";

const BUCKET = "mudar-workspace-files";
const created: string[] = [];
const admin = adminClient();

afterAll(async () => {
  if (created.length) await admin.storage.from(BUCKET).remove(created);
});

describe("storage: workspace-files cross-tenant isolation", () => {
  it("other tenant cannot read, list, sign, overwrite or delete WS1 objects", async () => {
    const owner = await userClient("owner");
    const path = `${WS1}/security/${tag("doc")}.txt`;
    const up = await owner.storage.from(BUCKET).upload(path, new Blob(["tenant one secret"]), { contentType: "text/plain" });
    expect(up.error).toBeNull();
    created.push(path);

    const other = await userClient("other");
    const dl = await other.storage.from(BUCKET).download(path);
    expect(dl.data).toBeNull();
    const ls = await other.storage.from(BUCKET).list(`${WS1}/security`);
    expect(ls.data ?? []).toEqual([]);
    const signed = await other.storage.from(BUCKET).createSignedUrl(path, 60);
    expect(signed.data?.signedUrl ?? null).toBeNull();
    const ow = await other.storage.from(BUCKET).upload(path, new Blob(["overwritten"]), { upsert: true });
    expect(ow.error).not.toBeNull();
    await other.storage.from(BUCKET).remove([path]);
    const still = await admin.storage.from(BUCKET).download(path);
    expect(await still.data?.text()).toBe("tenant one secret");

    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, db: { schema: "mudar" } });
    const adl = await anon.storage.from(BUCKET).download(path);
    expect(adl.data).toBeNull();
    const pub = await fetch(anon.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
    expect(pub.ok).toBe(false);
  });

  it("other tenant cannot write into WS1's prefix; can write into its own (positive control)", async () => {
    const other = await userClient("other");
    const bad = `${WS1}/security/${tag("planted")}.txt`;
    const r = await other.storage.from(BUCKET).upload(bad, new Blob(["x"]));
    expect(r.error).not.toBeNull();
    if (!r.error) created.push(bad);

    const good = `${WS2}/security/${tag("own")}.txt`;
    const ok = await other.storage.from(BUCKET).upload(good, new Blob(["mine"]));
    expect(ok.error).toBeNull();
    created.push(good);

    const owner = await userClient("owner");
    const cross = await owner.storage.from(BUCKET).download(good);
    expect(cross.data).toBeNull();
  });

  it("path tricks (.. segments, non-uuid prefix) do not cross tenants", async () => {
    const other = await userClient("other");
    const traversal = `${WS2}/../${WS1}/security/${tag("trav")}.txt`;
    const t = await other.storage.from(BUCKET).upload(traversal, new Blob(["x"]));
    if (!t.error) {
      created.push(traversal);
      const owner = await userClient("owner");
      const { data } = await owner.storage.from(BUCKET).list(`${WS1}/security`);
      expect((data ?? []).some((o) => o.name.includes("trav"))).toBe(false);
    }
    const nonUuid = `not-a-uuid/${tag("x")}.txt`;
    const n = await other.storage.from(BUCKET).upload(nonUuid, new Blob(["x"]));
    expect(n.error).not.toBeNull();
    if (!n.error) created.push(nonUuid);
  });

  it("viewer-level members cannot read files of records they cannot see (classification / account restriction)", async () => {
    // A restricted capture belonging to the owner: colleague cannot see the capture row via RLS ...
    const owner = await userClient("owner");
    const path = `${WS1}/captures/${tag("restricted")}.txt`;
    expect((await owner.storage.from(BUCKET).upload(path, new Blob(["restricted account audio"]))).error).toBeNull();
    created.push(path);
    const { data: cap, error } = await owner.from("capture").insert({
      workspace_id: WS1, kind: "text", raw_text: "restricted", storage_paths: [path], classification: "licensed_restricted",
    }).select().single();
    expect(error).toBeNull();
    const colleague = await userClient("colleague");
    const { data: seen } = await colleague.from("capture").select("id").eq("id", cap.id);
    expect(seen).toEqual([]);
    // ... so the file behind it must not be downloadable either (direct object URL).
    const dl = await colleague.storage.from(BUCKET).download(path);
    await admin.from("capture").delete().eq("id", cap.id);
    expect(dl.data).toBeNull();
  });
});
