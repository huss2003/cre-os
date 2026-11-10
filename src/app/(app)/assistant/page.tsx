import { requirePageContext } from "@/lib/auth/context";
import { AssistantPage } from "@/modules/assistant/ui/assistant-page";

export const metadata = { title: "Ask AI · CRE OS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; command?: string }> }) {
  await requirePageContext();
  const sp = await searchParams;
  return <AssistantPage conversationId={null} initialQuery={sp.q ?? ""} commandId={sp.command} />;
}
