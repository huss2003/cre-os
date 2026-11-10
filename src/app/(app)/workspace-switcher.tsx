import { switchWorkspace } from "./actions";

export function WorkspaceSwitcher({ current, workspaces }: { current: string; workspaces: { id: string; name: string }[] }) {
  if (workspaces.length <= 1) return <div className="truncate rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm font-medium text-ink">{workspaces[0]?.name}</div>;
  return (
    <form action={switchWorkspace} className="flex gap-1">
      <select name="workspace_id" defaultValue={current} className="min-h-11 w-full rounded-lg border border-line bg-canvas px-2 text-sm">
        {workspaces.map((w) => <option key={w.id} value={w.id} className="text-ink">{w.name}</option>)}
      </select>
      <button className="min-h-11 rounded-lg border border-line px-3 text-sm font-medium">Go</button>
    </form>
  );
}
