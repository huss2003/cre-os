"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
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
      <form action={submit} className="mt-2 grid gap-3 sm:grid-cols-2">
        <Field label="Attended?"><Select name="attended" defaultValue={initial?.attended === true ? "yes" : initial?.attended === false ? "no" : ""}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></Select></Field>
        <Field label="Client interest (1–5)"><Select name="clientRating" defaultValue={initial?.client_rating ?? ""}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        <Field label="Liked"><Textarea name="liked" rows={2} /></Field>
        <Field label="Concerns"><Textarea name="concerns" rows={2} /></Field>
        <Field label="Deal-breakers"><Textarea name="dealbreakers" rows={2} /></Field>
        <Field label="Next step" hint="Creates one follow-up task."><Input name="nextStep" defaultValue={initial?.next_step ?? ""} /></Field>
        <Field label="Follow up by"><Input type="date" name="followUpDue" /></Field>
        <div className="flex items-end gap-2"><Button type="submit" disabled={pending}>Save feedback</Button>{msg ? <span className="text-ink-soft" role="status">{msg}</span> : null}</div>
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
    <form action={submit} className="grid gap-3">
      <Field label="Title"><Input name="title" required placeholder="Site visit — Baner options" /></Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Date"><Input type="date" name="date" required /></Field>
        <Field label="From"><Input type="time" name="from" required /></Field>
        <Field label="To"><Input type="time" name="to" required /></Field>
      </div>
      <Field label="Location"><Input name="location" /></Field>
      <Field label="Attendee name"><Input name="attendeeName" /></Field>
      <Field label="Attendee email"><Input type="email" name="attendee" /></Field>
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={pending}>Draft invite</Button>{msg ? <span className="text-sm text-ink-soft" role="status">{msg}</span> : null}</div>
      <p className="text-xs text-ink-soft">CRE OS has no calendar write access. The invite becomes a draft you send from your own mail or calendar.</p>
    </form>
  );
}
