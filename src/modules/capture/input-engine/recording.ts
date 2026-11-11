import "server-only";
import { ChangeError } from "@/lib/services/changes";
import { publishEvent } from "@/modules/orchestrator/events/publish";
import { intakeDocument, mmss, type DocCtx, type DocDeps, type Segment } from "../docs/service";

/**
 * Permitted meeting recordings (spec §2.6). A recording is only accepted with an explicit consent confirmation
 * (and an optional reference: "verbal consent at start", a consent form id, ...). The audio is kept; the transcript keeps
 * per-segment timestamps when the speech-to-text provider returns them; speakers are marked uncertain (no diarisation).
 * Meeting-related content goes to Module 7 (meeting_note on the linked meeting + `meeting.notes_uploaded` event).
 */
export interface RecordingInput { name: string; mime: string; bytes: Uint8Array; storagePath?: string | null }
export interface RecordingOptions { consent: boolean; consentReference?: string | null; meetingPrepId?: string | null; languageHint?: string | null; typedText?: string | null }

export async function intakeRecording(ctx: DocCtx, file: RecordingInput, opts: RecordingOptions, deps: DocDeps = {}) {
  if (!opts.consent) throw new ChangeError("invalid_parameter", "Confirm that everyone in the recording agreed to it being recorded and processed.");
  const consentReference = (opts.consentReference?.trim() || "consent confirmed by uploader").slice(0, 300);
  const r = await intakeDocument(ctx, file, {
    userType: "audio", consentReference, languageHint: opts.languageHint ?? null, typedText: opts.typedText ?? null,
    links: opts.meetingPrepId ? { meeting_prep_id: opts.meetingPrepId } : {},
  }, deps);
  const doc = r.doc;
  if (doc.result?.transcript_id && (doc.result?.meeting_note_id || opts.meetingPrepId)) {
    try {
      await publishEvent(ctx.db, ctx.workspaceId, { type: "meeting.notes_uploaded", subjectType: "meeting_prep", subjectId: opts.meetingPrepId ?? null,
        payload: { capture_document_id: doc.id, transcript_id: doc.result.transcript_id, meeting_note_id: doc.result.meeting_note_id ?? null, has_timestamps: !!doc.result.has_timestamps, consent_reference: consentReference },
        dedupeKey: `capture_doc:${doc.id}:meeting_notes` });
    } catch { /* events are best effort; the note is saved */ }
  }
  return r;
}

/** Transcript lines with [mm:ss] references (Module 7 and the review screen use the same references). */
export function timestampedLines(segments: Segment[]): { ref: string; text: string; speaker: string | null; speaker_certain: boolean }[] {
  return segments.map((s) => ({ ref: mmss(s.start), text: s.text, speaker: s.speaker, speaker_certain: s.speaker_certain }));
}
