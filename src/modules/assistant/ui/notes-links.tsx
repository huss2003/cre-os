"use client";
import { useState } from "react";
import { EntityPicker, type PickerItem } from "@/components/ui/entity-picker";

/** "Link to…" pickers for the notes form. Choosing a company offers that company's open requirements. */
export function NotesLinks({ meeting, company, requirement }: { meeting?: PickerItem | null; company?: PickerItem | null; requirement?: PickerItem | null }) {
  const [org, setOrg] = useState<PickerItem | null>(company ?? null);
  const [reqKey, setReqKey] = useState(0);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <EntityPicker name="meetingId" kind="meeting" label="Meeting" defaultValue={meeting} placeholder="Search meeting title…" />
      <EntityPicker name="orgId" kind="company" label="Company" defaultValue={company} placeholder="Search company…"
        onSelect={(it) => { if (it?.id !== org?.id) { setOrg(it); setReqKey((k) => k + 1); } }} />
      <EntityPicker key={reqKey} name="requirementId" kind="requirement" label="Requirement" orgId={org?.id}
        defaultValue={reqKey === 0 ? requirement : null} placeholder={org ? `Open requirements at ${org.label}` : "Search requirement or company…"} />
    </div>
  );
}

/** Collapsible "Link to…" section. Owns its open state so a click on the summary always opens it
 *  (a server-rendered `open={false}` could be re-applied by React and snap it shut). */
export function NotesLinksToggle({ meeting, company, requirement }: { meeting?: PickerItem | null; company?: PickerItem | null; requirement?: PickerItem | null }) {
  const [open, setOpen] = useState(!!(meeting || company || requirement));
  return (
    <div className="text-sm">
      <button type="button" aria-expanded={open} aria-controls="notes-links-panel" onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 py-2 text-left text-ink-soft">
        <span aria-hidden>{open ? "▾" : "▸"}</span>Link to a meeting, company or requirement (optional)
      </button>
      <div id="notes-links-panel" hidden={!open} className="mt-3">
        <NotesLinks meeting={meeting} company={company} requirement={requirement} />
      </div>
    </div>
  );
}
