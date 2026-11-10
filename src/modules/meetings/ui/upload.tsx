"use client";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

const OK = /^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/;
/** Uploads a photo / PDF / floor plan straight to storage under <ws>/meetings/<prepId>/; the form saves the path. */
export function MaterialUploader({ workspaceId, prepId }: { workspaceId: string; prepId: string }) {
  const [path, setPath] = useState(""); const [mime, setMime] = useState(""); const [status, setStatus] = useState<string | null>(null);
  return (
    <span className="block">
      <input type="file" accept="image/*,application/pdf" aria-label="Photo, PDF or floor plan" className="block w-full text-sm" onChange={async (e) => {
        const file = e.target.files?.[0]; setPath(""); if (!file) return;
        if (!OK.test(file.type)) { setStatus("Choose a photo (PNG, JPEG, WebP, HEIC) or a PDF."); return; }
        if (file.size > 25 * 1024 * 1024) { setStatus("File is larger than 25 MB."); return; }
        setStatus("Uploading…");
        const safe = file.name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const p = `${workspaceId}/meetings/${prepId}/${crypto.randomUUID()}-${safe}`;
        const { error } = await createBrowserSupabase().storage.from("mudar-workspace-files").upload(p, file, { upsert: false, contentType: file.type });
        if (error) { setStatus(`Upload failed: ${error.message}`); return; }
        setPath(p); setMime(file.type); setStatus("Uploaded — press Attach to save it.");
      }} />
      <input type="hidden" name="storage_path" value={path} />
      <input type="hidden" name="mime" value={mime} />
      {status ? <span className="mt-1 block text-xs text-ink-soft" role="status">{status}</span> : null}
    </span>
  );
}
