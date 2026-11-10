import Link from "next/link";
import { Help, HelpFor, inr } from "@/components/ui";
import { Certainty, EmptyState, Field, OpenRow, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { startQuoteIntakeAction } from "@/modules/toolkit/actions-extras";
import { listIntakeOverview } from "@/modules/toolkit/quote-intake";
import { WorkspaceFileInput } from "./file-upload";

type Row = Record<string, any>;
const quoteName = (q: Row) => `${q.terms_json?.provider ?? "Quote"}${q.terms_json?.property ? ` — ${q.terms_json.property}` : ""} · v${q.version}`;

export default async function QuotesIntakePage() {
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const asOf = localDate();
  const [{ expired, current, intakes }, reqs, spaces] = await Promise.all([
    listIntakeOverview(ctx, asOf),
    app.db.from("requirement").select("id, title").eq("workspace_id", app.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    app.db.from("space").select("id, floor_text, unit, asset:asset_id(name)").eq("workspace_id", app.workspaceId).is("archived_at", null).limit(500),
  ]);
  const all = [...expired, ...current];
  const hasReqs = (reqs.data ?? []).length > 0;
  const intakeStatus = (st: string) => (st === "saved" ? <Status s="approved" label="Saved" /> : st === "review" ? <Status s="pending" label="Check terms" /> : <Status s={st} />);
  return (
    <div data-tour="toolkit-quotes" className="mx-auto max-w-4xl space-y-8 pb-16">
      <ToolHeader title="Compare landlord offers" purpose="Add a landlord, managed-office or fit-out quote. The terms are read for you to check, then saved as a new version — earlier versions are never overwritten."
        steps={["Add the quote", "Check the extracted terms", "Save as a new version"]} current={0}
        action={hasReqs ? <a href="#new-intake" className={btn.primary}>Add a quote</a> : undefined} />

      {expired.length ? (
        <section role="alert" className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm">
          <p className="flex items-center font-semibold text-rose-800">✕ {expired.length} expired quote{expired.length === 1 ? "" : "s"} — ask for a fresh quote<HelpFor k="Quotes expiring soon" /></p>
          <ul className="space-y-2">
            {expired.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2">
                <span><span className="font-medium">{quoteName(q)}</span> <span className="text-ink-soft">· {q.requirement?.title ?? "—"}</span></span>
                <span className="flex items-center gap-2 text-xs text-rose-700"><Status s="expired" />{q.valid_until}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section id="new-intake" className="scroll-mt-6 space-y-3">
        <h2 className="flex items-center text-lg font-semibold">Add a quote<Help>The quote text is treated as evidence only: nothing in it can trigger actions. Without an AI key, terms are pulled with simple pattern matching — check every field.</Help></h2>
        {!hasReqs ? <EmptyState title="No requirements yet" text="Quotes belong to a client requirement. Create one first, then add its quotes here." action={<Link href="/requirements" className={btn.primary}>Create a requirement</Link>} /> : (
          <ActionForm action={startQuoteIntakeAction} className="space-y-4 rounded-xl border border-line bg-surface p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requirement" htmlFor="qi-req" hint="Choose this for a brand-new quote.">
                <select id="qi-req" name="requirement_id" defaultValue="" className={inputCls}><option value="">Choose…</option>{(reqs.data ?? []).map((r: Row) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
              </Field>
              <Field label="…or update an existing quote" htmlFor="qi-quote" hint="Compares against its latest version.">
                <select id="qi-quote" name="quote_id" defaultValue="" className={inputCls}><option value="">— new quote —</option>{all.map((q) => <option key={q.id} value={q.id}>{quoteName(q)}</option>)}</select>
              </Field>
              <Field label="Building / space" htmlFor="qi-space" hint="Lets visit packs show the quote against the building.">
                <select id="qi-space" name="space_id" defaultValue="" className={inputCls}><option value="">— not linked —</option>{((spaces.data ?? []) as Row[]).map((x) => <option key={x.id} value={x.id}>{x.asset?.name ?? "Building"}{x.floor_text || x.unit ? ` · ${[x.floor_text, x.unit].filter(Boolean).join(" ")}` : ""}</option>)}</select>
              </Field>
              <Field label="Quote from" htmlFor="qi-party" required>
                <select id="qi-party" name="party_kind" defaultValue="landlord" className={inputCls}>
                  <option value="landlord">Landlord / developer</option><option value="managed_operator">Managed-office operator</option>
                  <option value="fitout_partner">Fit-out partner</option><option value="other">Other</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Quote file (PDF, DOCX, TXT)"><WorkspaceFileInput workspaceId={app.workspaceId} folder="quotes" accept=".pdf,.docx,.txt" exts={["pdf", "docx", "txt"]} /></Field>
              <Field label="…or paste the quote text" htmlFor="qi-text" hint="Scanned PDFs have no text layer — paste the text here."><textarea id="qi-text" name="text" rows={6} className={`${inputCls} py-2`} placeholder={"Rent: ₹85 per sq ft per month on chargeable area\nValid until: 31 Dec 2026"} /></Field>
            </div>
            <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0"><Submit className="w-full sm:w-auto">Read the terms →</Submit></div>
          </ActionForm>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Quotes waiting for you <span className="text-sm font-normal text-ink-soft">({intakes.length})</span></h2>
        {intakes.length === 0 ? <EmptyState title="No quotes added yet" text="Add a quote above. You will check the extracted terms before anything is saved." /> : (
          <ul className="space-y-2">
            {intakes.map((i) => (
              <li key={i.id}><OpenRow href={`/toolkit/quotes/${i.id}`} title={i.file_name ?? "Pasted text"} meta={i.requirement?.title ?? "—"} right={intakeStatus(String(i.status))} /></li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Current quotes <span className="text-sm font-normal text-ink-soft">({current.length})</span></h2>
        {current.length === 0 ? <EmptyState title="No saved quotes" text="Once you check and save a quote it appears here with its validity date." /> : (
          <ul className="space-y-2">
            {current.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
                <span className="min-w-0"><span className="block font-medium">{quoteName(q)}</span><span className="block text-ink-soft">{q.requirement?.title ?? "—"} · rent {q.terms_json?.rent != null ? <>{inr(q.terms_json.rent)} <Certainty c="quoted" /></> : <Certainty c="missing" />}</span></span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">{q.valid_until ? `Valid to ${q.valid_until}` : <Status s="needs_info" label="No validity date" />}{q.approved_at ? <Status s="approved" /> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
