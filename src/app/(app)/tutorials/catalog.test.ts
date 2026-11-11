import { describe, expect, it } from "vitest";
import type { TutorialVideo } from "./videos";
import { countByTopic, filterVideos, groupByTopic, neighbours, resolveTopic, topicsOf, tutorialsHref } from "./catalog";

const v = (slug: string, category: string, title: string, learn = "", captions: string[] = []): TutorialVideo =>
  ({ slug, category, title, learn, seconds: 30, tryRoute: "/today", featured: false, steps: captions.map((caption, i) => ({ caption, ms: i * 1000 })) });

const V = [
  v("tour", "Start here", "How CRE OS fits together", "Where things live"),
  v("import", "Records & data", "Import a spreadsheet", "Add each company", ["Upload the CSV file"]),
  v("company", "Records & data", "Open a company", "Tabs explained", ["Search for Zentrix"]),
  v("draft", "Outreach & meetings", "Write an email draft", "Nothing is sent", ["Copy to your mail app"]),
  v("ask", "Ask AI & automation", "Ask AI a question", "Answers with sources about a company"),
];

describe("tutorial catalogue helpers", () => {
  it("orders topics canonically", () => {
    expect(topicsOf([...V].reverse())).toEqual(["Start here", "Records & data", "Outreach & meetings", "Ask AI & automation"]);
  });
  it("resolves topics case-insensitively and rejects unknown", () => {
    expect(resolveTopic(V, "records & DATA")).toBe("Records & data");
    expect(resolveTopic(V, "nope")).toBe("");
  });
  it("filters by topic", () => {
    expect(filterVideos(V, { topic: "Records & data" }).map((x) => x.slug)).toEqual(["import", "company"]);
    expect(filterVideos(V, { topic: "unknown" })).toHaveLength(V.length);
  });
  it("searches title, learn line and step captions; all words must match", () => {
    expect(filterVideos(V, { q: "csv" }).map((x) => x.slug)).toEqual(["import"]);
    expect(filterVideos(V, { q: "zentrix" }).map((x) => x.slug)).toEqual(["company"]);
    expect(filterVideos(V, { q: "nothing sent" }).map((x) => x.slug)).toEqual(["draft"]);
    expect(filterVideos(V, { q: "email zebra" })).toEqual([]);
  });
  it("ranks title hits first", () => {
    expect(filterVideos(V, { q: "company" }).map((x) => x.slug)).toEqual(["company", "import", "ask"]);
  });
  it("combines topic and search", () => {
    expect(filterVideos(V, { topic: "Records & data", q: "company" }).map((x) => x.slug)).toEqual(["company", "import"]);
  });
  it("counts per topic for a query", () => {
    expect(countByTopic(V, "company")).toEqual({ "Start here": 0, "Records & data": 2, "Outreach & meetings": 0, "Ask AI & automation": 1 });
  });
  it("groups and finds neighbours within a topic", () => {
    expect(groupByTopic(V).map((g) => g.videos.length)).toEqual([1, 2, 1, 1]);
    expect(neighbours(V, "import")).toEqual({ prev: undefined, next: V[2] });
    expect(neighbours(V, "company").prev?.slug).toBe("import");
    expect(neighbours(V, "missing")).toEqual({ prev: undefined, next: undefined });
  });
  it("builds shareable links", () => {
    expect(tutorialsHref("Records & data", " csv ")).toBe("/tutorials?topic=Records+%26+data&q=csv#watch");
    expect(tutorialsHref()).toBe("/tutorials#watch");
  });
});

describe("automation (Module 9) tutorials", async () => {
  const { VIDEOS } = await import("./videos");
  const SLUGS = ["automation-overview-v2", "daily-plan-v2", "meeting-briefs-auto-v2", "failed-job-v2", "outdated-proposals-v2", "budgets-notifications-v2", "ask-ai-workflow-v2"];
  it("are in the manifest under Ask AI & automation with steps", () => {
    for (const s of SLUGS) {
      const x = VIDEOS.find((y) => y.slug === s);
      expect(x, s).toBeTruthy();
      expect(x!.category).toBe("Ask AI & automation");
      expect(x!.steps.length).toBeGreaterThan(5);
    }
  });
  it("are findable by search", () => {
    expect(filterVideos(VIDEOS, { q: "outdated proposals" })[0].slug).toBe("outdated-proposals-v2");
    expect(filterVideos(VIDEOS, { q: "retry" }).map((x) => x.slug)).toContain("failed-job-v2");
  });
});
