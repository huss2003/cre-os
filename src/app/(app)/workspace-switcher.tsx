import { switchWorkspace } from "./actions";

export function WorkspaceSwitcher({ current, workspaces }: { current: string; workspaces: { id: string; name: string }[] }) {
  if (workspaces.length <= 1) return <div className="truncate rounded-md bg-white/10 px-2 py-1.5 text-xs">{workspaces[0]?.name}</div>;
  return (
    <form action={switchWorkspace} className="flex gap-1">
      <select name="workspace_id" defaultValue={current} className="w-full rounded-md bg-white/10 px-2 py-1.5 text-xs text-white">
        {workspaces.map((w) => <option key={w.id} value={w.id} className="text-ink">{w.name}</option>)}
      </select>
      <button className="rounded-md bg-white/15 px-2 text-xs">Go</button>
    </form>
  );
}
