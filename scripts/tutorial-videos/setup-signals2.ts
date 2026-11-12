/**
 * Demo data for the "signals2" tutorial videos (Module 2 Signal Engine v2). Local Supabase + demo workspace ONLY. Synthetic.
 * Earlier tutorial signals for these companies are archived, then fresh ones are created through the real pipeline
 * (manual-paste adapter, signed in as the demo owner) so every recording starts from "new":
 *   - Peregrine Loom Studios (demo): hiring 250 people in Pune + new office  → used for approve + task
 *   - Quillstone Labs (demo): raised funding to expand in Pune                → used for snooze / dismiss / override
 *   - Ottervale Systems: named in the text but not a company record          → "Which company is this?" (unresolved)
 * Companies come from setup-leases.ts (run first if missing).
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-signals2.ts
 */
import { DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { userClient } from "../../tests/helpers";
import { processSourceItem } from "@/modules/signals/pipeline";

type Row = Record<string, any>;
const RUN = new Date().toISOString();
const TODAY = RUN.slice(0, 10);

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const admin = createAdminClient();
  const db = await userClient("owner");
  const org = async (n: string) => (await admin.from("organisation").select("id").eq("workspace_id", WS).eq("display_name", n).limit(1)).data?.[0]?.id as string | undefined;
  const peregrine = await org("Peregrine Loom Studios (demo)"), quill = await org("Quillstone Labs (demo)"), lumen = await org("Lumen Harbour Tech (demo)");
  if (!peregrine || !quill) throw new Error("tutorial companies missing — run setup-leases.ts first");

  // archive earlier tutorial signals (videos approve / snooze / dismiss them)
  const now = new Date().toISOString();
  const orgIds = [peregrine, quill, lumen].filter(Boolean) as string[];
  // signals are grouped by dedupe_key (unique) and items by content hash — retire both so the same news creates fresh signals
  const olds = [
    ...((await admin.from("signal").select("id, dedupe_key").eq("workspace_id", WS).in("org_id", orgIds).not("dedupe_key", "like", "%:retired:%")).data ?? []),
    ...((await admin.from("signal").select("id, dedupe_key").eq("workspace_id", WS).ilike("title", "%Ottervale%").not("dedupe_key", "like", "%:retired:%")).data ?? []),
  ] as { id: string; dedupe_key: string }[];
  for (const o of olds) await admin.from("signal").update({ archived_at: now, dedupe_key: `${o.dedupe_key}:retired:${RUN}` }).eq("workspace_id", WS).eq("id", o.id);
  // items: setup pastes and the texts the videos paste (same idempotency key would otherwise return the old, archived signal)
  const items = ((await admin.from("signal_source_item").select("id, content_hash, idempotency_key, raw_text").eq("workspace_id", WS)
    .or('idempotency_key.like.manual_paste:tutorial:%,raw_text.ilike."%Lumen Harbour Tech (demo)%",raw_text.ilike."%Quillstone Labs (demo)%",raw_text.ilike."%Peregrine Loom Studios (demo)%",raw_text.ilike.%Ottervale%')).data ?? []) as Row[];
  for (const it of items) {
    if (String(it.idempotency_key).includes(":retired:")) continue;
    await admin.from("signal_source_item").update({ idempotency_key: `${it.idempotency_key}:retired:${RUN}`, content_hash: it.content_hash ? `${it.content_hash}:retired:${RUN}` : null }).eq("workspace_id", WS).eq("id", it.id);
  }
  // the unresolved-company video may add "Ottervale Systems" as a company: archive it so the next run is unresolved again
  await admin.from("organisation").update({ archived_at: now }).eq("workspace_id", WS).ilike("display_name", "Ottervale Systems").is("archived_at", null);

  const paste = async (k: string, text: string, sourceName: string, extra: Record<string, string | undefined> = {}) => {
    const r = await processSourceItem(db as never, WS, { adapter: "manual_paste", text, sourceName, publishedOn: TODAY, actorUserId: OWNER, idempotencyKey: `manual_paste:tutorial:${k}:${RUN}`, ...extra } as never);
    console.log(k, r.status, (r.signals ?? []).length);
  };
  await paste("peregrine", "Peregrine Loom Studios (demo) announced it will hire 250 people in Pune over the next 12 months and is looking for a new office in Hinjewadi.", "Business Standard (demo)", { orgId: peregrine });
  await paste("quill", "Quillstone Labs (demo) has raised $40 million in Series C funding to expand its engineering team in Pune.", "Economic Times (demo)", { orgId: quill });
  await paste("ottervale", "Ottervale Systems announced it will hire 300 people in Pune and is looking for a new office in Kharadi.", "Local news (demo)", { companyName: "Ottervale Systems" });
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
