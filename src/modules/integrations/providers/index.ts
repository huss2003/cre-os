import { ProviderError } from "../types";
import "server-only";
import type { Db } from "@/lib/supabase/server";
import { isProviderConfigured } from "../config";
import { getValidAccessToken, type ConnectorAccountRow, type FetchLike } from "../tokens";
import type { ProviderAdapter } from "../types";
import { GoogleAdapter } from "./google";
import { MicrosoftAdapter } from "./microsoft";
import { MockAdapter } from "./mock";

export { MockAdapter, defaultMockFixtures } from "./mock";
export { MicrosoftAdapter } from "./microsoft";
export { GoogleAdapter } from "./google";

/**
 * Pick the adapter for a connector account. Mock when the account is in mock mode or credentials are absent.
 * Live adapters obtain (and refresh) tokens lazily through the service-role client (job context only).
 */
export function adapterFor(admin: Db, account: ConnectorAccountRow, fetchImpl: FetchLike = fetch): ProviderAdapter {
  if (account.status === "mock") return new MockAdapter(account.provider);
  // A REAL connected account must never be fed demo data because this server lacks the OAuth keys
  // (e.g. a second deployment sharing the database). Fail visibly instead.
  if (!isProviderConfigured(account.provider)) throw new ProviderError(0, `${account.provider} keys are not set on this server; it cannot sync this account`);
  const token = () => getValidAccessToken(admin, account, fetchImpl);
  return account.provider === "microsoft" ? new MicrosoftAdapter(token, fetchImpl) : new GoogleAdapter(token, fetchImpl);
}
