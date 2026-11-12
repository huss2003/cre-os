"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, Field, Input, Textarea } from "@/components/ui";
import { apiPost } from "@/modules/integrations/client-api";

export interface DraftView {
  id: string; channel: string; state: string; recipient_display: string | null; recipient_address: string | null; subject: string | null; body: string;
  purpose: string | null; content_hash: string; approved_hash: string | null; approved_at: string | null; marked_sent_at: string | null; sent_evidence: string | null;
  pause_reason: string | null; row_version: number; created_by_kind: string; updated_label: string;
}

const STATE_TONE: Record<string, "neutral" | "brand" | "ok" | "warn" | "bad" | "accent"> = {
  drafted: "neutral", approved: "brand", opened_for_send: "accent", marked_sent: "ok", reconciled_sent: "ok", discarded: "neutral", paused: "warn",
};
const STATE_LABEL: Record<string, string> = {
  drafted: "Drafted", approved: "Approved", opened_for_send: "Opened to send", marked_sent: "Marked sent (your assertion)",
  reconciled_sent: "Sent (confirmed in Sent Items)", discarded: "Discarded", paused: "Paused",
};
const OPEN_LABEL: Record<string, string> = { email: "Open in Mail", introduction: "Open in Mail", calendar_invite: "Open in Mail", whatsapp: "Open WhatsApp", linkedin: "Open LinkedIn", post: "Open LinkedIn" };

export function DraftCard({ d, canEdit }: { d: DraftView; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ recipientAddress: d.recipient_address ?? "", subject: d.subject ?? "", body: d.body });
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<{ href: string | null; copyText: string } | null>(null);
  const live = !!d.approved_hash && d.approved_hash === d.content_hash;
  const sent = d.state === "marked_sent" || d.state === "reconciled_sent";
  const hasSubject = ["email", "introduction", "calendar_invite"].includes(d.channel);

  const run = (fn: () => Promise<void>) => start(async () => { setMsg(null); await fn(); router.refresh(); });

  const save = () => run(async () => {
    const r = await apiPost(`/api/v1/drafts/${d.id}`, {
      expectedVersion: d.row_version, recipientAddress: form.recipientAddress || null, ...(hasSubject ? { subject: form.subject || null } : {}), body: form.body,
    }, "PATCH");
    if (!r.ok) return setMsg(r.error);
    setEditing(false);
    const inv = (r.data as { approvalInvalidated?: boolean }).approvalInvalidated;
    setMsg(inv ? "Saved. The content changed, so the previous approval was removed — review and approve again." : "Saved.");
  });
  const approve = () => run(async () => {
    const r = await apiPost(`/api/v1/drafts/${d.id}/approve`, { reviewedHash: d.content_hash, expectedVersion: d.row_version });
    setMsg(r.ok ? "Approved. Use “Open to send” to send it from your own app." : r.error);
  });
  const open = () => run(async () => {
    const r = await apiPost<{ href: string | null; copyText: string }>(`/api/v1/drafts/${d.id}/open`);
    if (!r.ok) return setMsg(r.error);
    setLink(r.data);
    if (r.data.href?.startsWith("mailto:")) window.location.href = r.data.href;
  });
  const markSent = () => run(async () => {
    const r = await apiPost(`/api/v1/drafts/${d.id}/mark-sent`);
    setMsg(r.ok ? "Marked as sent. If your mailbox is connected, Sent Items will confirm it." : r.error);
  });
  const discard = () => run(async () => {
    if (!confirm("Discard this draft?")) return;
    const r = await apiPost(`/api/v1/drafts/${d.id}/discard`, {});
    if (!r.ok) setMsg(r.error);
  });
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMsg("Copied to clipboard."); } catch { setMsg("Copy failed — select the text and copy it manually."); }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[d.state] ?? "neutral"}>{STATE_LABEL[d.state] ?? d.state}</Badge>
        <Badge>{d.channel.replace("_", " ")}</Badge>
        {d.created_by_kind !== "user" ? <Badge tone="accent" title="Prepared for you from your records — review before approving">Prepared draft</Badge> : null}
        {d.state === "paused" && d.pause_reason ? <Badge tone="warn">{d.pause_reason.replace("_", " ")}</Badge> : null}
        <span className="ml-auto text-xs text-ink-soft">{d.updated_label}</span>
      </div>
      <div className="mt-3 text-sm">
        <div className="break-words"><span className="text-ink-soft">To: </span>{d.recipient_display ?? "—"}{d.recipient_address ? <span className="text-ink-soft"> · {d.recipient_address}</span> : null}</div>
        {d.purpose ? <div className="text-xs text-ink-soft">{d.purpose}</div> : null}
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          <Field label="Recipient address / number / profile URL"><Input value={form.recipientAddress} onChange={(e) => setForm({ ...form, recipientAddress: e.target.value })} /></Field>
          {hasSubject ? <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field> : null}
          <Field label="Message" hint="Changing the recipient, subject or text removes any approval."><Textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3 text-sm">
          {d.subject ? <div className="mb-2 font-medium break-words">{d.subject}</div> : null}
          <div className="whitespace-pre-wrap break-words">{d.body}</div>
        </div>
      )}
      <div className="mt-2 text-xs text-ink-soft">
        Content hash {d.content_hash.slice(0, 10)}… {live ? "· approval matches this content" : d.approved_hash ? "· approval is out of date" : "· not approved"}
        {d.sent_evidence ? ` · evidence: ${d.sent_evidence.startsWith("sent_items:") ? "Sent Items" : "your assertion"}` : ""}
      </div>
      {link ? (
        <div className="mt-3 flex flex-wrap gap-2 rounded-lg border border-brand/30 bg-brand-soft p-3 text-sm">
          <span className="w-full text-ink-soft">CRE OS does not send messages. Send it from your own app, then press “Mark sent”.</span>
          {link.href ? <a className="font-medium text-brand underline" href={link.href} target={link.href.startsWith("mailto:") ? undefined : "_blank"} rel="noopener noreferrer">{OPEN_LABEL[d.channel] ?? "Open"} ↗</a> : null}
          <button type="button" className="font-medium text-brand underline" onClick={() => copy(link.copyText)}>Copy text</button>
        </div>
      ) : null}
      {msg ? <p className="mt-2 text-sm text-ink-soft" role="status">{msg}</p> : null}
      {canEdit && !sent && d.state !== "discarded" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button disabled={pending} onClick={save}>Save</Button>
              <Button variant="secondary" disabled={pending} onClick={() => { setEditing(false); setForm({ recipientAddress: d.recipient_address ?? "", subject: d.subject ?? "", body: d.body }); }}>Cancel</Button>
            </>
          ) : (
            <>
              {d.state === "drafted" || (d.state === "approved" && !live) ? <Button disabled={pending} onClick={approve}>Approve</Button> : null}
              {(d.state === "approved" || d.state === "opened_for_send") && live ? <Button disabled={pending} onClick={open}>Open to send</Button> : null}
              {d.state === "opened_for_send" ? <Button variant="secondary" disabled={pending} onClick={markSent}>Mark sent</Button> : null}
              <Button variant="secondary" disabled={pending} onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="ghost" disabled={pending} onClick={() => copy(d.subject && hasSubject ? `Subject: ${d.subject}\n\n${d.body}` : d.body)}>Copy</Button>
              <Button variant="ghost" disabled={pending} onClick={discard}>Discard</Button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
