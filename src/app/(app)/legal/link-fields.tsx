import { Field, Select } from "@/components/ui";

export type LinkOptions = { leases: { id: string; label: string }[]; orgs: { id: string; label: string }[]; assets: { id: string; label: string }[] };

/** Related lease / company / building (lets Lease Radar match the document's clauses to a lease). Plain component: usable in server and client forms. */
export function LinkFields({ options }: { options: LinkOptions }) {
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-2">
      <legend className="px-1 text-xs text-ink-soft">Related to (lets Lease Radar use these clauses)</legend>
      <Field label="Lease" hint="Choosing a lease fills the company and building."><Select name="lease_id" defaultValue="">{[<option key="" value="">None</option>, ...options.leases.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)]}</Select></Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Company"><Select name="org_id" defaultValue="">{[<option key="" value="">{options.leases.length ? "From lease / none" : "None"}</option>, ...options.orgs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)]}</Select></Field>
        <Field label="Building"><Select name="asset_id" defaultValue="">{[<option key="" value="">{options.leases.length ? "From lease / none" : "None"}</option>, ...options.assets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)]}</Select></Field>
      </div>
    </fieldset>
  );
}
