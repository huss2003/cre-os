/** Notice used on negotiation pages. */
export function NothingSent() {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
      <span aria-hidden className="font-bold">i</span>
      <span><strong>Nothing is accepted, rejected or sent from here.</strong> This is your private workbench — you decide and you contact the landlord yourself.</span>
    </p>
  );
}
