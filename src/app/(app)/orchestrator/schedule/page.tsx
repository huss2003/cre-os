import { redirect } from "next/navigation";

/** Moved into /automation (tabs). Kept as a redirect for old links and notifications. */
export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const v = (await searchParams).view;
  redirect(`/automation?view=${v === "weekly" || v === "budgets" || v === "notifications" ? v : "daily"}`);
}
