import Link from "next/link";
import type { AppContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/context";
import { Badge, Button, Field, Input, MoreFields, Select, Textarea } from "@/components/ui";
import { personOptions } from "../research/queries";
import { isoDate } from "../common";
import { fmtDay, label } from "../ui";
import { relationshipsForPerson, EDGE_TYPES, WARMTHS, type EdgeView } from "./relationships";
import { relationshipAction, consentAction, revokeConsentAction, introDraftAction, endRelationshipAction } from "./actions";

/* Network-intelligence UI: record who knows whom and introduction consent. Server component; mobile-first. */

export function RelationshipForm({ back, people, toPersonId, toName }: { back: string; people: { id: string; name: string }[]; toPersonId?: string; toName?: string }) {
  const others = people.filter((p) => p.id !== toPersonId);
  return (
    <form action={relationshipAction} className="max-w-md space-y-4">
      <input type="hidden" name="back" value={back} />
        <Field label="Who knows them?">
          <Select name="from" defaultValue="me">{[<option key="me" value="me">Me</option>, ...others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)]}</Select>
        </Field>
        {toPersonId ? <><input type="hidden" name="to_person_id" value={toPersonId} /><Field label="Knows"><Input value={toName ?? ""} disabled readOnly /></Field></>
          : <Field label="Knows"><Select name="to_person_id" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)]}</Select></Field>}
        <Field label="Relationship"><Select name="edge_type" defaultValue="worked_with">{EDGE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
      <MoreFields>
        <Field label="Strength"><Select name="warmth" defaultValue="warm">{WARMTHS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label="Last contact"><Input name="last_contact" type="date" max={isoDate(new Date())!} /></Field>
        <Field label="Context" hint="How they know each other, in your words. Don't record sensitive personal traits or other clients' deal details."><Textarea name="strength_basis" maxLength={500} /></Field>
      </MoreFields>
      <Button type="submit" variant="secondary">Save relationship</Button>
    </form>
  );
}

function ConsentForm({ edge, back }: { edge: EdgeView; back: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-brand">Record introduction consent</summary>
      <form action={consentAction} className="mt-2 max-w-md space-y-4 rounded-lg border border-line p-3">
        <input type="hidden" name="back" value={back} /><input type="hidden" name="edge_id" value={edge.id} />
          <Field label="Given by"><Select name="given_by" defaultValue="introducer"><option value="introducer">{edge.from_label} (introducer)</option><option value="target">{edge.to_label}</option><option value="both">Both</option></Select></Field>
          <Field label="Given on"><Input name="given_on" type="date" required max={isoDate(new Date())!} defaultValue={isoDate(new Date())!} /></Field>
          <Field label="How"><Select name="method" defaultValue="conversation">{["conversation", "email", "message", "meeting", "call", "other"].map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
        <MoreFields>
          <Field label="Scope"><Input name="scope" maxLength={300} placeholder="e.g. Pune office search" /></Field>
          <Field label="Expires"><Input name="expires_on" type="date" /></Field>
        </MoreFields>
        <Field label="Note"><Input name="evidence" maxLength={1000} placeholder="e.g. agreed on call, 'happy to connect you'" /></Field>
        <Button variant="secondary">Record consent</Button>
      </form>
    </details>
  );
}

function EdgeItem({ e, back, canEdit }: { e: EdgeView; back: string; canEdit: boolean }) {
  const active = e.consents.filter((c) => c.active);
  const needsIntro = !e.mine; // own relationships need no introduction
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span>{e.from_person_id ? <Link className="text-brand" href={`/people/${e.from_person_id}`}>{e.from_label}</Link> : e.from_label} → <Link className="text-brand" href={`/people/${e.to_person_id}`}>{e.to_label}</Link></span>
        <Badge>{label(e.edge_type)}</Badge>{e.warmth ? <Badge tone="brand">{e.warmth}</Badge> : null}
        {e.valid_to ? <Badge tone="neutral">ended {fmtDay(e.valid_to)}</Badge> : null}
        {needsIntro ? (active.length ? <Badge tone="ok">intro consent recorded</Badge> : <Badge tone="warn">no intro consent — ask first</Badge>) : <Badge>your relationship</Badge>}
      </div>
      <div className="text-xs text-ink-soft">{e.last_contact ? `Last contact ${fmtDay(e.last_contact)}` : "Last contact unknown"}{e.strength_basis ? ` · ${e.strength_basis}` : ""}</div>
      {e.consents.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {e.consents.map((c) => (
            <li key={String(c.id)} className="flex flex-wrap items-center gap-1">
              <span>Consent given by {String(c.given_by)} on {fmtDay(String(c.given_on))} via {String(c.method)}{c.scope ? ` (${String(c.scope)})` : ""} · recorded {fmtDay(String(c.created_at))}{c.owner_user_id ? " by a team member" : ""}</span>
              {c.revoked_at ? <Badge tone="bad">revoked {fmtDay(String(c.revoked_at))}</Badge> : c.active ? <Badge tone="ok">active</Badge> : <Badge tone="warn">expired</Badge>}
              {canEdit && !c.revoked_at && (
                <form action={revokeConsentAction} className="inline"><input type="hidden" name="back" value={back} /><input type="hidden" name="consent_id" value={String(c.id)} /><button className="text-bad underline">revoke</button></form>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && !e.valid_to && (
        <div className="mt-1 flex flex-wrap items-start gap-3">
          {needsIntro && <ConsentForm edge={e} back={back} />}
          {needsIntro && e.from_person_id && active.length > 0 && (
            <form action={introDraftAction}><input type="hidden" name="back" value={back} /><input type="hidden" name="edge_id" value={e.id} /><button className="text-xs text-brand underline">Draft intro request to {e.from_label}</button></form>
          )}
          <form action={endRelationshipAction}><input type="hidden" name="back" value={back} /><input type="hidden" name="edge_id" value={e.id} /><input type="hidden" name="row_version" value={String(e.row_version)} /><button className="text-xs text-ink-soft underline">end relationship</button></form>
        </div>
      )}
    </li>
  );
}

/** Panel for the person page: relationships + introduction consent. */
export async function RelationshipPanel({ ctx, personId, personName }: { ctx: AppContext; personId: string; personName: string }) {
  const canEdit = hasRole(ctx, "editor");
  const [edges, people] = await Promise.all([relationshipsForPerson(ctx.db, ctx.workspaceId, personId, ctx.userId), canEdit ? personOptions(ctx.db, ctx.workspaceId) : Promise.resolve([])]);
  const back = `/people/${personId}`;
  return (
    <section id="relationships" className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-soft">Relationships &amp; introduction consent</h2>
      {edges.length === 0 ? <p className="text-sm text-ink-soft">No relationships recorded. Record who knows {personName} below.</p> : (
        <ul className="divide-y divide-line">{edges.map((e) => <EdgeItem key={e.id} e={e} back={back} canEdit={canEdit} />)}</ul>
      )}
      {canEdit && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-brand">Record a relationship</summary>
          <div className="mt-2"><RelationshipForm back={back} people={people} toPersonId={personId} toName={personName} /></div>
        </details>
      )}
    </section>
  );
}
