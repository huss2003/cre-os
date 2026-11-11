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
