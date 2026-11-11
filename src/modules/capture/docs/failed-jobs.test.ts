import { describe, it, expect, vi } from "vitest";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("./actions", () => ({ retryJobAction: async () => ({ ok: true }) }));
vi.mock("@/modules/changes/ui/client", () => ({
  ActionForm: ({ children }: { children: ReactNode }) => h("form", null, children),
  Submit: ({ children }: { children: ReactNode }) => h("button", null, children),
}));
import { FailedJobsQueue } from "./failed-jobs";
import { errorSummary, jobLabel, jobRecordLink } from "./review";

const DOC = "2b7c3f0e-1111-4c4c-8a8a-123456789abc";
const job = { id: "j1", job_type: "capture.document", state: "dead", attempts: 5, max_attempts: 5, updated_at: "2026-11-10T10:00:00Z",
  last_error: "OCR failed: missing key\n  at stack line", payload: { documentId: DOC } };

describe("failed jobs queue", () => {
  it("plain-words labels, one-line error summary, related record link", () => {
    expect(jobLabel("imports.process")).toBe("Importing a spreadsheet");
    expect(jobLabel("foo.bar_baz")).toBe("Bar baz (foo)");
    expect(errorSummary("first line\nsecond")).toBe("first line");
    expect(errorSummary(null)).toMatch(/No error/);
    expect(jobRecordLink(job)).toEqual({ href: `/capture/documents/${DOC}`, label: "Open file" });
    expect(jobRecordLink({ job_type: "imports.process", payload: { batch_id: DOC } })!.href).toBe(`/imports/${DOC}`);
    expect(jobRecordLink({ job_type: "brief.radar", payload: {} })).toBeNull();
  });
  it("admins see each failed job with Retry and a link", () => {
    const html = renderToStaticMarkup(h(FailedJobsQueue, { jobs: [job], count: 1, admin: true }));
    expect(html).toContain("Processing an uploaded file");
    expect(html).toContain("OCR failed: missing key");
    expect(html).not.toContain("stack line");
    expect(html).toContain("5/5 tries");
    expect(html).toContain("Retry");
    expect(html).toContain(`/capture/documents/${DOC}`);
  });
  it("admins with nothing failed get an explanatory empty state", () => {
    expect(renderToStaticMarkup(h(FailedJobsQueue, { jobs: [], count: 0, admin: true }))).toContain("No failed background jobs");
  });
  it("non-admins see only the count and who can fix it — no Retry", () => {
    const html = renderToStaticMarkup(h(FailedJobsQueue, { jobs: null, count: 3, admin: false }));
    expect(html).toContain("3 background jobs failed");
    expect(html).toContain("admin");
    expect(html).not.toContain("Retry");
  });
});
