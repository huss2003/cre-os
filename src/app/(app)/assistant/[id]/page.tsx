import { requirePageContext } from "@/lib/auth/context";
import { AssistantPage } from "@/modules/assistant/ui/assistant-page";

export const metadata = { title: "Ask AI · CRE OS" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  await requirePageContext();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <AssistantPage conversationId={id} initialQuery={sp.q ?? ""} />;
}
