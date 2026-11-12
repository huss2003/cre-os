/** "Check ready to present" purpose — kept in the URL so the dropdown keeps the user's choice after the redirect. */
export type ReadyPurpose = "presentation" | "site_visit";
export const readyPurpose = (v: unknown): ReadyPurpose => (v === "site_visit" ? "site_visit" : "presentation");
export const matchPath = (requirementId: string, purpose: ReadyPurpose) =>
  `/buildings/supply?tab=match&requirement=${encodeURIComponent(requirementId)}${purpose === "site_visit" ? "&purpose=site_visit" : ""}`;
