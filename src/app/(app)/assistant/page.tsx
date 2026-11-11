import { requirePageContext } from "@/lib/auth/context";
import { UsageBanner } from "@/modules/assistant/usage/ui";
import { AssistantPage } from "@/modules/assistant/ui/assistant-page";

export const metadata = { title: "Ask AI · CRE OS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; command?: string }> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  return <><UsageBanner workspaceId={ctx.workspaceId} /><AssistantPage conversationId={null} initialQuery={sp.q ?? ""} commandId={sp.command} /></>;
}
