import { switchWorkspace } from "./actions";

export function WorkspaceSwitcher({ current, workspaces }: { current: string; workspaces: { id: string; name: string }[] }) {
  if (workspaces.length <= 1) return <div className="truncate rounded-xl border border-line bg-canvas px-3 py-2 text-xs font-medium text-ink-soft">{workspaces[0]?.name}</div>;
  return (
    <form action={switchWorkspace} className="flex gap-1">
      <select name="workspace_id" defaultValue={current} className="w-full rounded-xl border border-line bg-canvas px-2 py-2 text-xs">
        {workspaces.map((w) => <option key={w.id} value={w.id} className="text-ink">{w.name}</option>)}
      </select>
      <button className="rounded-xl border border-line px-2 text-xs font-medium">Go</button>
    </form>
  );
}
