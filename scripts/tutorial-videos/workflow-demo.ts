/**
 * Drives the "lease → renewal / relocation" automation for the Zentrix demo lease, for the tutorial video.
 *   prepare  — remove this demo lease's earlier run (and the requirement/task/proposal it made), then start the chain:
 *              it stops at "waiting for approval" because creating a requirement is a material change (S4).
 *   resume   — what the scheduled sweep does after the approval: continue the chain.
 *   cleanup  — the removal part of prepare, plus requirements made by earlier capture recordings (so other videos start clean).
 * Only touches rows created by this chain for the demo lease in the demo workspace.
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/workflow-demo.ts prepare|resume
 */
import { createClient } from "@supabase/supabase-js";
import { DEMO_WORKSPACE_ID as WS, did } from "../demo-data";
import { runLeaseChain } from "@/modules/workflows/service";

const LEASE = did("tutorial:lease", "zentrix-kharadi");

async function main() {
  const mode = process.argv[2];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.SUPABASE_SECRET_KEY!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createClient(url, key, { auth: { persistSession: false }, db: { schema: "mudar" } });
  const must = async <T,>(p: PromiseLike<{ data: T; error: { message: string } | null }>) => { const r = await p; if (r.error) throw new Error(r.error.message); return r.data; };

  if (mode === "prepare" || mode === "cleanup") {
    const runs = (await must(db.from("workflow_run").select("id").eq("workspace_id", WS).like("dedupe_key", `lease:${LEASE}:%`))) as { id: string }[];
    if (runs.length) {
      await must(db.from("workflow_step").delete().eq("workspace_id", WS).in("run_id", runs.map((r) => r.id)));
      await must(db.from("workflow_run").delete().eq("workspace_id", WS).in("id", runs.map((r) => r.id)));
    }
    const now = new Date().toISOString();
    const { data: org } = await db.from("lease").select("tenant_org_id").eq("id", LEASE).single();
    await must(db.from("task").update({ archived_at: now, idempotency_key: null }).eq("workspace_id", WS).like("idempotency_key", `workflows:lease:${LEASE}:%`));
    await must(db.from("requirement").update({ archived_at: now }).eq("workspace_id", WS).eq("org_id", org!.tenant_org_id).like("title", "Renewal or relocation — %").is("archived_at", null));
    // the proposal's idempotency key must be free so the chain proposes again (rename it; history stays)
    await must(db.from("change_proposal").update({ idempotency_key: `${`workflows:lease:${LEASE}:requirement`}:old:${Date.now()}` }).eq("workspace_id", WS).eq("idempotency_key", `workflows:lease:${LEASE}:requirement`));
    // earlier, still-open proposals from previous recordings would show twice in Review
    await must(db.from("change_proposal").update({ archived_at: now }).eq("workspace_id", WS).like("idempotency_key", `workflows:lease:${LEASE}:requirement:old:%`).is("archived_at", null));
  }
  if (mode === "cleanup") {
    // extra requirements made by earlier capture recordings would make the capture video ask "which requirement?"
    const { data: org } = await db.from("lease").select("tenant_org_id").eq("id", LEASE).single();
    await must(db.from("requirement").update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS).eq("org_id", org!.tenant_org_id).like("title", "% (from capture %").is("archived_at", null));
    console.log("cleaned up"); return;
  }
  const r = await runLeaseChain(db as never, WS, LEASE);
  console.log(`lease chain (${mode}):`, r ? JSON.stringify(r).slice(0, 300) : "nothing to do");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
