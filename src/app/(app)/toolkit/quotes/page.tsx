import Link from "next/link";
import { Badge, Card, EmptyState, Field, Help, HelpFor, PageHeader, Select, Textarea, inr } from "@/components/ui";
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
  return (
    <div className="space-y-5">
      <PageHeader title="Quotation intake" subtitle="Upload or paste a landlord, managed-office operator or fit-out partner quote. Terms are extracted for you to check, then saved as a new quote version — earlier versions are never overwritten." />

      {expired.length ? (
        <Card title={<span>Expired quotes <Badge tone="bad">{expired.length}</Badge></span>} help={<HelpFor k="Quotes expiring soon" />}>
          <ul className="divide-y divide-line text-sm">
            {expired.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-medium">{quoteName(q)}</span> <span className="text-ink-soft">· {q.requirement?.title ?? "—"}</span></span>
                <span className="text-xs text-bad">expired {q.valid_until} — ask for a fresh quote</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="New intake" help={<Help>The quote text is treated as evidence only: nothing in it can trigger actions. Without an AI key, terms are pulled with simple pattern matching — check every field.</Help>}>
        {(reqs.data ?? []).length === 0 ? <EmptyState title="No requirements yet">Quotes belong to a requirement. Create one under Requirements first.</EmptyState> : (
          <ActionForm action={startQuoteIntakeAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Requirement" hint="For a new quote.">
              <Select name="requirement_id" defaultValue=""><option value="">—</option>{(reqs.data ?? []).map((r: Row) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select>
            </Field>
            <Field label="Or update an existing quote" hint="Compares against its latest version.">
              <Select name="quote_id" defaultValue=""><option value="">— new quote —</option>{all.map((q) => <option key={q.id} value={q.id}>{quoteName(q)}</option>)}</Select>
            </Field>
            <Field label="Building / space" hint="For a new quote — lets packs show it against the building.">
              <Select name="space_id" defaultValue=""><option value="">— not linked —</option>{((spaces.data ?? []) as Row[]).map((x) => <option key={x.id} value={x.id}>{x.asset?.name ?? "Building"}{x.floor_text || x.unit ? ` · ${[x.floor_text, x.unit].filter(Boolean).join(" ")}` : ""}</option>)}</Select>
            </Field>
            <Field label="Quote from">
              <Select name="party_kind" defaultValue="landlord">
                <option value="landlord">Landlord / developer</option><option value="managed_operator">Managed-office operator</option>
                <option value="fitout_partner">Fit-out partner</option><option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Quote file (PDF, DOCX, TXT)"><WorkspaceFileInput workspaceId={app.workspaceId} folder="quotes" accept=".pdf,.docx,.txt" exts={["pdf", "docx", "txt"]} /></Field>
            <div className="sm:col-span-2"><Field label="Or paste the quote text" hint="Scanned PDFs have no text layer — paste the text here."><Textarea name="text" rows={6} placeholder={"Rent: ₹85 per sq ft per month on chargeable area\nValid until: 31 Dec 2026"} /></Field></div>
            <div className="sm:col-span-2"><Submit>Extract terms</Submit></div>
          </ActionForm>
        )}
      </Card>

      <Card title="Recent intakes">
        {intakes.length === 0 ? <EmptyState title="No intakes yet">Upload a quote above; you will review the extracted terms before anything is saved.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {intakes.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link className="text-brand" href={`/toolkit/quotes/${i.id}`}>{i.file_name ?? "Pasted text"} · {i.requirement?.title ?? "—"}</Link>
                <Badge tone={i.status === "saved" ? "ok" : i.status === "review" ? "warn" : "neutral"}>{i.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Current quotes">
        {current.length === 0 ? <EmptyState title="No current quotes">Saved quote versions appear here with their validity.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {current.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-medium">{quoteName(q)}</span> <span className="text-ink-soft">· {q.requirement?.title ?? "—"} · rent {q.terms_json?.rent != null ? inr(q.terms_json.rent) : "unknown"}</span></span>
                <span className="flex gap-1.5 text-xs text-ink-soft">{q.valid_until ? `valid to ${q.valid_until}` : <Badge tone="warn">no validity date</Badge>}{q.approved_at ? <Badge tone="ok">approved</Badge> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
