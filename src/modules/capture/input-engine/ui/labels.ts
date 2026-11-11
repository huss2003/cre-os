export const FACT_CLASS_LABEL: Record<string, string> = {
  confirmed: "Confirmed", estimate: "Estimate", assumption: "Assumption", hypothesis: "Hypothesis", commitment: "Commitment", task: "Task", preference: "Preference",
};
export const FACT_TONE: Record<string, "ok" | "warn" | "neutral" | "brand" | "accent"> = {
  confirmed: "ok", estimate: "warn", assumption: "warn", hypothesis: "accent", commitment: "brand", task: "brand", preference: "neutral",
};
export const TIER_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { high: "ok", medium: "warn", low: "warn", none: "neutral" };
export const FIELD_LABEL: Record<string, string> = {
  area_target: "Area needed", area_target_sf: "Area needed", area: "Area (basis not stated)", carpet_area: "Carpet area", chargeable_area: "Chargeable area",
  super_built_up_area: "Super built-up area", rent_psf: "Rent per sq ft", monthly_rent: "Monthly rent", annual_rent: "Annual rent", budget: "Budget", cam: "CAM",
  security_deposit: "Security deposit", rent_free: "Rent-free period", lock_in: "Lock-in", lease_duration: "Lease term", escalation: "Escalation", notice_period: "Notice period",
  fitout_cost: "Fit-out cost", brokerage: "Brokerage", parking: "Parking", preferred_location: "Preferred location", occupation_target: "Move-in target",
  decision_target: "Decision target", task: "Task", commitment: "Commitment", objection: "Objection", preference: "Preference", signal: "Business signal", hypothesis: "Hypothesis",
  seats_target: "Seats", budget_max: "Budget",
  contact_name: "Name", contact_title: "Title", company_name: "Company", contact_email: "Email", contact_phone: "Phone", company_website: "Website", company_address: "Address",
};
export function sourceLabel(ref: Record<string, unknown> | null | undefined): string {
  if (!ref) return "";
  const parts: string[] = [];
  if (ref.page) parts.push(`${ref.file_name ? "p." : "page "}${ref.page}`);
  if (ref.timestamp) parts.push(`at ${ref.timestamp}`);
  if (ref.file_name) parts.push(String(ref.file_name));
  if (!parts.length && ref.locator) parts.push(String(ref.locator).startsWith("transcript") ? "transcript" : String(ref.locator).startsWith("photo_text") ? "photo text" : "note");
  return parts.join(" · ");
}

/** Capture kind as the user knows it ("audio" with no file = text dictated with the microphone). */
export const CAPTURE_KIND_LABEL: Record<string, string> = { text: "typed note", audio: "voice note", image: "photo", mixed: "file" };
export const captureKindLabel = (kind: string) => CAPTURE_KIND_LABEL[kind] ?? kind;

export const LANGUAGE_LABEL: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish", mr: "Marathi" };
/** Detected language (extraction meta) first, else the user's hint; null when neither is known. */
export function languageLabel(detected: string | null | undefined, hint?: string | null): string | null {
  const k = detected || hint;
  return k ? LANGUAGE_LABEL[k] ?? k : null;
}

/** How the capture is (or will be) logged as an interaction. A voice note that mentions a call is a note about the call. */
export function interactionLogWording(kind: string, channel: string | null | undefined, reviewed: boolean): string {
  const verb = reviewed ? "Logged" : "Will be logged";
  const src = kind === "audio" ? "voice note" : kind === "image" ? "photo" : "note";
  if (!channel || channel === "note") return `${verb} as a ${src}.`;
  return `${verb} as a ${channel} (recorded from your ${src}).`;
}
