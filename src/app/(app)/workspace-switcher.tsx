import { switchWorkspace } from "./actions";

export function WorkspaceSwitcher({ current, workspaces }: { current: string; workspaces: { id: string; name: string }[] }) {
  if (workspaces.length <= 1) return <div className="truncate rounded-md px-2 py-1 text-xs font-medium text-ink-soft">{workspaces[0]?.name}</div>;
  return (
    <form action={switchWorkspace} className="flex gap-1">
      <select name="workspace_id" aria-label="Workspace" defaultValue={current} className="min-h-11 w-full rounded-md border border-line bg-surface px-2 text-xs lg:min-h-8">
        {workspaces.map((w) => <option key={w.id} value={w.id} className="text-ink">{w.name}</option>)}
      </select>
      <button className="min-h-11 rounded-md border border-line bg-surface px-2.5 text-xs font-medium lg:min-h-8">Go</button>
    </form>
  );
}
