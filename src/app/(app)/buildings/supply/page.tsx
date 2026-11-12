import { Suspense } from "react";
import Link from "next/link";
import { Badge, Button, ButtonLink, Card, EmptyState, FactBadge, Field, Input, PageHeader, Select, StaleBanner, Table, Td, Textarea, sf } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { Loading } from "@/modules/admin/ui/parts";
import { toDealsCtx } from "@/modules/deals/api";
import {
  SUPPLY_STATUS_LABEL, availabilityStatus, contiguousLabel, commercialTerms, matchRequirement, operatorCentres, reconfirmationDue, shortlistHistory,
} from "@/modules/deals/supply";
import { floorLabel, unitLabel } from "@/modules/deals/matching/match";
import { codeLabel } from "@/lib/util/labels";
import { addOperatorCentreAction, checkReadyAction, shortlistFeedbackAction } from "@/modules/deals/supply/actions";

export const metadata = { title: "Property supply" };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const confTone = { high: "ok", medium: "brand", low: "warn", none: "bad" } as const;
const termText = (t: { value: unknown; status: string }) => t.status === "missing" ? "unknown" : `${t.value}${t.status === "historical" ? " (historical)" : ""}`;

async function Inventory({ ctx }: { ctx: Awaited<ReturnType<typeof requirePageContext>> }) {
  const asOf = new Date().toISOString().slice(0, 10);
  const { data: avs } = await ctx.db.from("availability").select("*, space:space_id(id, floor_text, unit, chargeable_sf, carpet_sf, contiguous_group, divisible, asset:asset_id(id, name, category, status, completion_date))")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("as_of", { ascending: false }).limit(300);
  const seen = new Set<string>();
  const rows = (avs ?? []).filter((a) => { const k = a.space_id as string; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!rows.length) return <EmptyState title="No supply recorded yet" action={<ButtonLink href="/imports">Import availability</ButtonLink>}>Import an availability list or add a building with spaces. Each availability row should carry a source and a verification date.</EmptyState>;
  const stale = rows.filter((r) => availabilityStatus(r as never, { asOf }).stale).length;
  return <>
    {stale ? <StaleBanner>{stale} of {rows.length} availability observations are stale — reconfirm before presenting.</StaleBanner> : null}
    <Table head={["Property", "Status", "Area", "Rent / CAM", "Source · verified", "Confidence"]}>
      {rows.map((r) => {
        const sp = r.space as { floor_text?: string; unit?: string; chargeable_sf?: number; carpet_sf?: number; contiguous_group?: string; asset?: { id: string; name: string; category?: string; status?: string; completion_date?: string } };
        const st = availabilityStatus(r as never, { asOf, assetStatus: sp?.asset?.status, assetCompletion: sp?.asset?.completion_date });
        const t = commercialTerms(r as never, null, { asOf });
        return <tr key={r.id as string}>
          <Td><Link className="underline" href={`/buildings/${sp?.asset?.id}`}>{sp?.asset?.name}</Link>{floorLabel(sp?.floor_text) ? ` · ${floorLabel(sp?.floor_text)}` : ""}{unitLabel(sp?.unit) ? ` · ${unitLabel(sp?.unit)}` : ""}
            <div className="text-xs text-ink-soft">{sp?.asset?.category ? codeLabel(sp.asset.category) : "category unknown"}{contiguousLabel(sp?.contiguous_group) ? ` · part of a contiguous block (${contiguousLabel(sp?.contiguous_group)})` : ""}</div></Td>
          <Td><Badge tone={st.immediate ? "ok" : st.offerable ? "warn" : "bad"}>{SUPPLY_STATUS_LABEL[st.status]}</Badge>{st.availableFrom ? <div className="text-xs text-ink-soft">from {st.availableFrom}</div> : null}</Td>
          <Td>{sf(sp?.chargeable_sf ?? sp?.carpet_sf ?? null)}</Td>
          <Td>{termText(t.terms.rent)} / {termText(t.terms.cam)}</Td>
          <Td>{(r.source_label as string) ?? "source not recorded"} · {(r.last_verified_on as string) ?? "never verified"} <FactBadge status={r.fact_status as string} /></Td>
          <Td><Badge tone={confTone[st.confidence]}>{codeLabel(st.confidence)}</Badge></Td>
        </tr>;
      })}
    </Table>
  </>;
}

async function Operators({ ctx }: { ctx: Awaited<ReturnType<typeof requirePageContext>> }) {
  const rows = await operatorCentres(toDealsCtx(ctx));
  return <>
    {rows.length ? <Table head={["Operator · centre", "Seats", "Private offices", "Price / seat", "Services · charges", "Brokerage · verified"]}>
      {rows.map((c) => <tr key={c.id}>
        <Td>{c.operator_name} · {c.centre_name}<div className="text-xs text-ink-soft">{codeLabel(String(c.category))}</div></Td>
        <Td>{c.seats_available ?? "unknown"} available / {c.capacity_seats ?? "unknown"}</Td>
        <Td>{c.private_offices ?? "unknown"}</Td>
        <Td>{c.price_per_seat_min ?? "?"}–{c.price_per_seat_max ?? "?"}</Td>
        <Td>{(c.services ?? []).join(", ") || "—"}{(c.additional_charges ?? []).length ? <div className="text-xs text-ink-soft">+ {(c.additional_charges as { label: string }[]).map((x) => x.label).join(", ")}</div> : null}</Td>
        <Td>{c.brokerage_conditions ?? "unknown"} · {c.last_verified_on ?? "never verified"}</Td>
      </tr>)}
    </Table> : <EmptyState title="No managed office or coworking centres yet">Add operator centres below to track seats, pricing, services, contract terms and brokerage.</EmptyState>}
    {hasRole(ctx, "editor") ? <Card title="Add centre" className="mt-4">
      <form action={addOperatorCentreAction} className="grid gap-3 sm:grid-cols-2">
        <Field label="Operator"><Input name="operator_name" required /></Field>
        <Field label="Centre"><Input name="centre_name" required /></Field>
        <Field label="Type"><Select name="category"><option value="managed_office">Managed office</option><option value="coworking">Coworking</option></Select></Field>
        <Field label="Capacity (seats)"><Input name="capacity_seats" inputMode="numeric" /></Field>
        <Field label="Seats available"><Input name="seats_available" inputMode="numeric" /></Field>
        <Field label="Private offices"><Input name="private_offices" inputMode="numeric" /></Field>
        <Field label="Price per seat (min)"><Input name="price_per_seat_min" inputMode="decimal" /></Field>
        <Field label="Price per seat (max)"><Input name="price_per_seat_max" inputMode="decimal" /></Field>
        <Field label="Services (comma-separated)"><Input name="services" /></Field>
        <Field label="Amenities (comma-separated)"><Input name="amenities" /></Field>
        <Field label="Brokerage conditions"><Input name="brokerage_conditions" /></Field>
        <Field label="Source"><Input name="source_label" /></Field>
        <Field label="Last verified on"><Input type="date" name="last_verified_on" /></Field>
        <div className="sm:col-span-2"><Button type="submit">Save centre</Button></div>
      </form>
    </Card> : null}
  </>;
}

async function Match({ ctx, requirementId }: { ctx: Awaited<ReturnType<typeof requirePageContext>>; requirementId: string }) {
  if (!requirementId) {
    const { data } = await ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(50);
    if (!data?.length) return <EmptyState title="No requirements yet" action={<ButtonLink href="/requirements">Add a requirement</ButtonLink>}>Matching runs a client requirement against the supply inventory.</EmptyState>;
    return <ul className="space-y-1 text-sm">{data.map((r) => <li key={r.id}><Link className="underline" href={`/buildings/supply?tab=match&requirement=${r.id}`}>{r.title}</Link></li>)}</ul>;
  }
  const dctx = toDealsCtx(ctx);
  const [matches, due, hist] = await Promise.all([matchRequirement(dctx, requirementId), reconfirmationDue(dctx, requirementId), shortlistHistory(dctx, requirementId)]);
  const optBySpace = new Map<string, { id: string; option_status: string }>();
  const latest = hist.versions[0]?.version;
  for (const o of hist.options) if (o.version === latest) optBySpace.set(o.space_id as string, o as never);
  return <>
    {due.length ? <StaleBanner>{due.length} shortlisted propert{due.length === 1 ? "y needs" : "ies need"} reconfirmation before presentation or site visits: {due.map((d) => `${d.label} (${d.items.map((i) => codeLabel(i.code).toLowerCase()).join(", ")})`).join("; ")}</StaleBanner> : null}
    <form action={checkReadyAction} className="mb-3 flex flex-wrap gap-2">
      <input type="hidden" name="requirement_id" value={requirementId} />
      <Select name="purpose" aria-label="Purpose"><option value="presentation">Client presentation</option><option value="site_visit">Site visit</option></Select>
      <Button type="submit" variant="secondary">Check ready to present</Button>
      <ButtonLink href={`/requirements/${requirementId}`} variant="secondary">Requirement</ButtonLink>
    </form>
    {!matches.length ? <EmptyState title="No inventory to match">Import availability first.</EmptyState> : <div className="space-y-3">
      {matches.slice(0, 40).map((m) => {
        const e = m.explanation; const opt = optBySpace.get(m.spaceId);
        return <Card key={m.spaceId} title={<span>#{m.rank} {m.label} <Badge tone={m.eligibility === "eligible" ? "ok" : m.eligibility === "ineligible" ? "bad" : "warn"}>{codeLabel(m.eligibility)}</Badge> <Badge tone={confTone[e.availabilityConfidence]}>availability {e.availabilityConfidence}</Badge></span>}
          actions={<span className="text-sm">fit {m.fitScore} · data {m.completenessScore}%</span>}>
          <p className="text-sm">{e.why}</p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {([["Fails (hard filters)", e.fails], ["Satisfies", e.satisfies], ["Advantages", e.advantages], ["Disadvantages", e.disadvantages], ["Missing information", e.missing], ["Verification required", e.verificationRequired]] as [string, string[]][]).map(([k, v]) =>
              v.length ? <div key={k}><dt className="font-medium">{k}</dt><dd><ul className="list-disc pl-5 text-ink-soft">{v.map((x, i) => <li key={i}>{x}</li>)}</ul></dd></div> : null)}
          </dl>
          {opt ? <form action={shortlistFeedbackAction} className="mt-3 grid gap-2 sm:grid-cols-4">
            <input type="hidden" name="requirement_id" value={requirementId} /><input type="hidden" name="option_id" value={opt.id} />
            <Select name="kind" aria-label="Feedback type"><option value="client_feedback">Client feedback</option><option value="rejection">Rejection</option></Select>
            <Select name="reason_code" aria-label="Reason"><option value="">Reason (required for rejection)</option>{["price", "area", "location", "timing", "specification", "landlord", "parking", "availability", "other"].map((r) => <option key={r} value={r}>{codeLabel(r)}</option>)}</Select>
            <Textarea name="comment" rows={1} aria-label="Comment" placeholder="Comment" />
            <Button type="submit" variant="secondary">Record ({codeLabel(opt.option_status).toLowerCase()})</Button>
          </form> : <p className="mt-2 text-xs text-ink-soft">Not in the latest stored shortlist — run the shortlist on the requirement to record feedback.</p>}
        </Card>;
      })}
    </div>}
    {hist.feedback.length ? <Card title="Shortlist history" className="mt-4"><ul className="text-sm">{hist.versions.map((v) => <li key={v.id}>v{v.version} · {v.as_of} · {v.eligible_count} eligible / {v.candidate_count}</li>)}</ul>
      <ul className="mt-2 text-sm text-ink-soft">{hist.feedback.map((f) => <li key={f.id}>{f.kind === "rejection" ? "Rejected" : "Feedback"}{f.reason_code ? ` (${f.reason_code})` : ""}: {f.comment ?? ""}</li>)}</ul></Card> : null}
  </>;
}

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const tab = one(sp.tab) || "inventory";
  const msg = one(sp.msg), err = one(sp.err);
  const tabs: [string, string][] = [["inventory", "Inventory"], ["operators", "Operators"], ["match", "Match"]];
  return <>
    <PageHeader title="Property supply" subtitle="Current availability, commercial terms, matching explanations and verification status. Lease expiry and future supply are never shown as vacancy." />
    {msg ? <p className="mb-3 rounded-lg border border-ok/30 bg-ok/10 p-2 text-sm">{msg}</p> : null}
    {err ? <p role="alert" className="mb-3 rounded-lg border border-bad/30 bg-bad/10 p-2 text-sm">{err}</p> : null}
    <div className="mb-3 flex flex-wrap gap-2 text-sm" role="tablist" aria-label="Supply view">
      {tabs.map(([k, l]) => <ButtonLink key={k} href={`/buildings/supply?tab=${k}`} variant={tab === k ? "primary" : "secondary"}>{l}</ButtonLink>)}
    </div>
    {tab === "operators" ? <Operators ctx={ctx} /> : tab === "match" ? <Match ctx={ctx} requirementId={one(sp.requirement)} /> : <Inventory ctx={ctx} />}
  </>;
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
