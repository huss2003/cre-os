"use client";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Generic file picker for Module 8: uploads straight to storage under <ws>/<folder>/... with the signed-in user's
 * session (storage RLS: editors write under their workspace) and puts path + name in hidden fields. The server action
 * re-validates the path prefix.
 */
export function WorkspaceFileInput({ workspaceId, folder, accept, exts }: { workspaceId: string; folder: "quotes" | "evidence"; accept: string; exts: string[] }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  return (
    <span className="block">
      <input type="file" accept={accept} aria-label="Choose a file to upload" className="block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-1.5 text-sm file:mr-3 file:min-h-8 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:font-semibold file:text-brand hover:border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" onChange={async (e) => {
        const file = e.target.files?.[0];
        setPath(""); setName("");
        if (!file) return;
        const ext = file.name.toLowerCase().split(".").pop() ?? "";
        if (!exts.includes(ext)) { setStatus(`Choose a ${exts.map((x) => `.${x}`).join(", ")} file.`); return; }
        if (file.size > 20 * 1024 * 1024) { setStatus("File is larger than 20 MB."); return; }
        setStatus("Uploading…");
        const safe = file.name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const p = `${workspaceId}/${folder}/${crypto.randomUUID()}-${safe}`;
        const { error } = await createBrowserSupabase().storage.from("mudar-workspace-files").upload(p, file, { upsert: false, contentType: file.type || undefined });
        if (error) { setStatus(`Upload failed: ${error.message}`); return; }
        setPath(p); setName(file.name);
        setStatus("Uploaded.");
      }} />
      <input type="hidden" name="storage_path" value={path} />
      <input type="hidden" name="file_name" value={name} />
      {status ? <span role="status" className="mt-1 block text-xs text-ink-soft">{status}</span> : null}
    </span>
  );
}
