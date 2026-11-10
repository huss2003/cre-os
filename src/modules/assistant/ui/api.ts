"use client";
import type { Block, EntityRef, RunStatus, StreamEvent } from "../types";

/** Client wrappers for /api/v1/assistant/* (engine + memory agents own the routes). */
const BASE = "/api/v1/assistant";
const key = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now() + Math.random()));

export interface ConversationItem { id: string; title: string | null; last_message_at: string | null; pinned: boolean; context_entity_type: string | null }
export interface StoredMessage { id: string; seq: number; role: string; content: string | null; blocks: Block[] | null; status: string | null; created_at: string }
export interface SavedCommand { id: string; name: string; prompt: string }

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json", "idempotency-key": key() }, body: JSON.stringify(body) });

export const api = {
  list: (q = "") => fetch(`${BASE}/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => json<{ items: ConversationItem[] }>(r)),
  get: (id: string) => fetch(`${BASE}/conversations/${id}`).then((r) => json<{ conversation: ConversationItem; messages: StoredMessage[] }>(r)),
  patch: (id: string, body: { title?: string; pinned?: boolean }) => post(`${BASE}/conversations/${id}`, body, "PATCH").then((r) => json<unknown>(r)),
  archive: (id: string) => fetch(`${BASE}/conversations/${id}`, { method: "DELETE", headers: { "idempotency-key": key() } }).then((r) => json<unknown>(r)),
  decide: (id: string, decision: "approve" | "reject") => post(`${BASE}/approvals/${id}`, { decision }).then((r) => json<{ status: string; blocks?: Block[] }>(r)),
  feedback: (messageId: string, rating: "up" | "down", comment?: string) => post(`${BASE}/feedback`, { messageId, rating: rating === "up" ? 1 : -1, comment }).then((r) => json<unknown>(r)),
  upload: (file: File, conversationId?: string | null) => {
    const fd = new FormData(); fd.append("file", file); if (conversationId) fd.append("conversationId", conversationId);
    return fetch(`${BASE}/attachments`, { method: "POST", body: fd, headers: { "idempotency-key": key() } }).then((r) => json<{ id: string; name: string; pages?: number; chars?: number }>(r));
  },
  /** Saved commands (memory agent). 404 / failure → empty list. */
  commands: async (): Promise<SavedCommand[]> => {
    try {
      const r = await fetch(`${BASE}/commands`);
      if (!r.ok) return [];
      const b = await r.json();
      const items = (Array.isArray(b) ? b : b.items ?? []) as Record<string, unknown>[];
      return items.map((c) => ({ id: String(c.id), name: String(c.name ?? c.title ?? "Command"), prompt: String(c.prompt ?? c.body ?? "") })).filter((c) => c.prompt);
    } catch { return []; }
  },
};

/** POST chat and feed every SSE `data:` event to onEvent. Resolves when the stream ends. */
export async function streamChat(body: { conversationId?: string | null; message: string; focus?: EntityRef | null; attachmentIds?: string[]; commandId?: string },
  onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/chat`, { method: "POST", signal, headers: { "content-type": "application/json", accept: "text/event-stream", "idempotency-key": key() }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    throw new Error((b as { error?: string }).error ?? `Assistant unavailable (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try { onEvent(JSON.parse(data) as StreamEvent); } catch { /* ignore malformed */ }
    }
  }
}

export type { RunStatus };
