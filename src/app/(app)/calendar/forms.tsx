"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, MoreFields, Select, Textarea } from "@/components/ui";
import { apiPost } from "@/modules/integrations/client-api";

export function FeedbackForm({ id, initial }: { id: string; initial?: { attended: boolean | null; client_rating: number | null; next_step: string | null } | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (fd: FormData) => start(async () => {
    const v = (k: string) => (String(fd.get(k) ?? "").trim() || null);
    const rating = v("clientRating");
    const r = await apiPost(`/api/v1/calendar/${id}/feedback`, {
      attended: fd.get("attended") === "yes" ? true : fd.get("attended") === "no" ? false : null, clientRating: rating ? Number(rating) : null,
      liked: v("liked"), concerns: v("concerns"), dealbreakers: v("dealbreakers"), nextStep: v("nextStep"), followUpDue: v("followUpDue"),
    });
    setMsg(r.ok ? "Feedback saved." : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer font-medium text-brand">{initial ? "Edit visit feedback" : "Add visit feedback"}</summary>
      <form action={submit} className="mt-2 max-w-md space-y-4">
        <Field label="Attended?"><Select name="attended" defaultValue={initial?.attended === true ? "yes" : initial?.attended === false ? "no" : ""}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></Select></Field>
        <Field label="Client interest (1–5)"><Select name="clientRating" defaultValue={initial?.client_rating ?? ""}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        <Field label="Next step" hint="Creates one follow-up task."><Input name="nextStep" defaultValue={initial?.next_step ?? ""} /></Field>
        <MoreFields>
          <Field label="Liked"><Textarea name="liked" rows={2} /></Field>
          <Field label="Concerns"><Textarea name="concerns" rows={2} /></Field>
          <Field label="Deal-breakers"><Textarea name="dealbreakers" rows={2} /></Field>
          <Field label="Follow up by"><Input type="date" name="followUpDue" /></Field>
        </MoreFields>
        <div className="flex items-center gap-2"><Button type="submit" disabled={pending}>Save feedback</Button>{msg ? <span className="text-ink-soft" role="status">{msg}</span> : null}</div>
      </form>
    </details>
  );
}

export function InviteDraftForm({ tz }: { tz: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (fd: FormData) => start(async () => {
    const date = String(fd.get("date") ?? ""), from = String(fd.get("from") ?? ""), to = String(fd.get("to") ?? "");
    if (!date || !from || !to) return setMsg("Pick a date, start and end time.");
    const off = tz === "Asia/Kolkata" ? "+05:30" : "Z";
    const r = await apiPost("/api/v1/calendar/invites", {
      title: String(fd.get("title") ?? ""), start: `${date}T${from}:00${off}`, end: `${date}T${to}:00${off}`,
      location: String(fd.get("location") ?? "") || null, attendeeAddress: String(fd.get("attendee") ?? "") || null, attendeeName: String(fd.get("attendeeName") ?? "") || null,
    });
    setMsg(r.ok ? "Invite drafted — review and send it from Drafts → Invites." : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <form action={submit} className="max-w-md space-y-4">
      <Field label="Title"><Input name="title" required placeholder="Site visit — Baner options" /></Field>
      <Field label="Date"><Input type="date" name="date" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><Input type="time" name="from" required /></Field>
        <Field label="To"><Input type="time" name="to" required /></Field>
      </div>
      <Field label="Attendee email"><Input type="email" name="attendee" /></Field>
      <MoreFields>
        <Field label="Attendee name"><Input name="attendeeName" /></Field>
        <Field label="Location"><Input name="location" /></Field>
      </MoreFields>
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={pending}>Draft invite</Button>{msg ? <span className="text-sm text-ink-soft" role="status">{msg}</span> : null}</div>
    </form>
  );
}

export interface ChecklistRow { key: string; label: string; done: boolean; custom: boolean }

/** Visit checklist: large tap targets, each tick saves immediately (works on a phone at the building). */
export function ChecklistPanel({ id, items, canEdit }: { id: string; items: ChecklistRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(items);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const done = rows.filter((r) => r.done).length;
  const toggle = (key: string, value: boolean) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, done: value } : r)));
    start(async () => {
      const r = await apiPost(`/api/v1/calendar/${id}/checklist`, { itemKey: key, done: value });
      if (!r.ok) {
        setRows((rs) => rs.map((x) => (x.key === key ? { ...x, done: !value } : x)));
        setMsg(r.error);
      } else setMsg(null);
    });
  };
  const add = (fd: FormData) => start(async () => {
    const label = String(fd.get("label") ?? "").trim();
    if (!label) return;
    const r = await apiPost(`/api/v1/calendar/${id}/checklist`, { label, done: false });
    setMsg(r.ok ? null : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer font-medium text-brand">Checklist ({done}/{rows.length})</summary>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.key}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-brand-soft">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={r.done} disabled={!canEdit || pending} onChange={(e) => toggle(r.key, e.target.checked)} />
              <span className={r.done ? "text-ink-soft line-through" : ""}>{r.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form action={add} className="mt-2 flex gap-2">
          <Input name="label" placeholder="Add an item" aria-label="Add a checklist item" />
          <Button type="submit" variant="secondary" disabled={pending}>Add</Button>
        </form>
      ) : null}
      {msg ? <p className="mt-1 text-xs text-bad" role="status">{msg}</p> : null}
    </details>
  );
}

/** Confirm / cancel a hand-planned visit. */
export function VisitStatusButtons({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (s: "confirmed" | "cancelled") => start(async () => {
    const r = await apiPost(`/api/v1/calendar/${id}`, { status: s }, "PATCH");
    setMsg(r.ok ? null : r.error);
    if (r.ok) router.refresh();
  });
  if (status === "cancelled" || status === "completed") return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {status === "provisional" ? <Button type="button" variant="secondary" disabled={pending} onClick={() => set("confirmed")}>Confirm</Button> : null}
      <Button type="button" variant="ghost" disabled={pending} onClick={() => set("cancelled")}>Cancel visit</Button>
      {msg ? <span className="text-xs text-ink-soft" role="status">{msg}</span> : null}
    </div>
  );
}

/** Plan a visit / meeting by hand. Linking a building gives coordinates for travel estimates and route grouping. */
export function PlannedVisitForm({ tz, assets, opportunities }: { tz: string; assets: { id: string; label: string }[]; opportunities: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (fd: FormData) => start(async () => {
    const date = String(fd.get("date") ?? ""), from = String(fd.get("from") ?? ""), to = String(fd.get("to") ?? "");
    if (!date || !from || !to) return setMsg("Pick a date, start and end time.");
    const off = tz === "Asia/Kolkata" ? "+05:30" : "Z";
    const r = await apiPost("/api/v1/calendar", {
      title: String(fd.get("title") ?? ""), kind: String(fd.get("kind") ?? "site_visit"), start: `${date}T${from}:00${off}`, end: `${date}T${to}:00${off}`,
      assetId: String(fd.get("assetId") ?? "") || null, location: String(fd.get("location") ?? "") || null, opportunityId: String(fd.get("opportunityId") ?? "") || null,
    });
    setMsg(r.ok ? "Planned (provisional). Confirm it once the client and landlord agree." : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <form action={submit} className="max-w-md space-y-4">
      <Field label="Title"><Input name="title" required placeholder="Site visit — Baner options" /></Field>
      <Field label="Date"><Input type="date" name="date" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><Input type="time" name="from" required /></Field>
        <Field label="To"><Input type="time" name="to" required /></Field>
      </div>
      <Field label="Building" hint={assets.length ? "Gives the address and coordinates for travel estimates." : "No buildings yet — add them under Buildings, or type a location."}>
        <Select name="assetId" defaultValue=""><option value="">— none —</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
      </Field>
      <MoreFields>
        <Field label="Type"><Select name="kind" defaultValue="site_visit"><option value="site_visit">Site visit</option><option value="meeting">Meeting</option></Select></Field>
        <Field label="Or location"><Input name="location" placeholder="e.g. Baner, Pune" /></Field>
        {opportunities.length ? (
          <Field label="Opportunity"><Select name="opportunityId" defaultValue=""><option value="">— none —</option>{opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
        ) : null}
      </MoreFields>
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={pending}>Plan visit</Button>{msg ? <span className="text-sm text-ink-soft" role="status">{msg}</span> : null}</div>
    </form>
  );
}
