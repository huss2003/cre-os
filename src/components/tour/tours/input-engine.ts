import type { Tour } from "../types";

export const tour: Tour = {
  key: "input",
  module: "Module 10",
  title: "Capture & imports",
  summary: "Capture a note, voice note, card or quote, review what was extracted, and import spreadsheets with mapping and validation.",
  minutes: 6,
  learned: [
    "Capture takes notes, voice notes (English, Hindi, Hinglish), cards, quotes and documents",
    "The receipt says what was saved, matched, questioned and scheduled; unclear values become one question",
    "Each extracted item can be confirmed, edited, rejected, linked, created or sent back as a question",
    "Imports suggest column mappings, validate every row and never delete or overwrite on re-upload",
    "Source and From capture links show where a value came from",
  ],
  steps: [
    { route: "/capture", title: "One place for everything you hear and receive", body: "Type or speak a note after a call, or drop quotes, leases, business cards, photos, voice notes and spreadsheets. Nothing changes a record until you approve it." },
    { route: "/capture", title: "The receipt", body: "After saving, the receipt lists what was saved, which people and companies were matched (with confidence), the questions it needs answered and the tasks it scheduled — for example a Friday follow-up." },
    { route: "/capture", title: "Units are never guessed", body: "\"Budget is 85\" becomes one question: ₹85 per sq ft per month? Is CAM extra? Carpet, chargeable and super built-up areas are never converted." },
    { route: "/capture", title: "Voice, Hindi and Hinglish", body: "Speak in English, Hindi or Hinglish, or upload a recording with consent. Fix a misheard word with 'Correct the note / transcript' — the correction history keeps both versions." },
    { route: "/capture/review", title: "Review queue", body: "Only what needs a person: uncertain matches, duplicates, conflicting values (₹85 → ₹95 keeps both), missing units or dates, unverified lease details and material changes." },
    { route: "/imports", title: "Spreadsheets", body: "Upload one file or many. Columns are matched by header with a confidence score; an admin can correct a mapping once and it is remembered. The validation report flags invalid emails, phones and ambiguous dates." },
    { route: "/imports", title: "Re-uploads and batches", body: "The same file name with new content becomes version 2: changed, added and removed rows are listed and nothing is deleted. Batches show progress, a completion report and Retry for temporary failures." },
    { route: "/capture/history", title: "Where did this come from?", body: "Company, person and building pages link to 'Source' (spreadsheet file, version and cell) and 'From capture' (the note or document). Capture history lists everything captured." },
  ],
};
