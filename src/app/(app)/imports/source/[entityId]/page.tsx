import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ButtonLink, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { recordTrace } from "@/modules/imports/service";
import { Loading, StatusBadge } from "@/modules/imports/ui";

export const metadata = { title: "Record source" };
type Params = Promise<{ entityId: string }>;

/** Spec §11: where a record's values came from — file, version, worksheet and cell — and how they changed. */
async function Body({ params }: { params: Params }) {
  const ctx = await requirePageContext("viewer");
  const { entityId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) notFound();
  const { sources, history } = await recordTrace(ctx, entityId);
  return (
    <>
      <PageHeader title="Record source" subtitle="Every spreadsheet row behind this record, with the worksheet and cell of each value." actions={<ButtonLink variant="ghost" href="/imports">Imports</ButtonLink>} />
      {sources.length === 0 ? (
        <EmptyState title="No spreadsheet source">This record was not created or confirmed by an import. Captures and documents show their sources on the capture review page.</EmptyState>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => (
            <Card key={s.staged_row_id} title={<span className="text-sm">{s.file_name} · v{s.version ?? 1} · {s.locator}</span>}
              actions={s.original_url ? <a className="text-sm text-brand" href={s.original_url}>Open original</a> : null}>
              <p className="mb-2 text-xs text-ink-soft">Imported {s.imported_at ? fmt(s.imported_at) : "—"} · row status {s.status} · <Link className="underline" href={`/imports/${s.batch_id}`}>import report</Link></p>
              <Table head={["Field", "Cell", "Value in file"]}>
                {s.values.map((v) => <tr key={v.field}><Td>{v.field.replace(/^custom:/, "").replace(/_/g, " ")}</Td><Td className="whitespace-nowrap font-mono text-xs">{v.cell}</Td><Td>{v.raw === null ? "—" : String(v.raw)}</Td></tr>)}
              </Table>
            </Card>
          ))}
        </div>
      )}
      <Card title="Value history" className="mt-4">
        {history.length === 0 ? <p className="text-sm text-ink-soft">No imported value has disagreed with this record.</p> : (
          <Table head={["Field", "On record", "In file", "Where", "Status"]}>
            {history.map((h: { id: string; field: string; master_value: unknown; source_value: unknown; source_label: string | null; source_locator: string | null; observed_at: string; status: string }) => (
              <tr key={h.id}><Td>{h.field.replace(/_/g, " ")}</Td><Td>{h.master_value === null ? "Unknown" : String(h.master_value)}</Td><Td>{String(h.source_value)}</Td>
                <Td className="text-xs">{h.source_label} {h.source_locator}<div className="text-ink-soft">{fmt(h.observed_at)}</div></Td><Td><StatusBadge status={h.status} /></Td></tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-ink-soft">Imports never overwrite a saved value: a different value is kept here and proposed for approval.</p>
      </Card>
    </>
  );
}

export default function Page({ params }: { params: Params }) {
  return <Suspense fallback={<Loading />}><Body params={params} /></Suspense>;
}
