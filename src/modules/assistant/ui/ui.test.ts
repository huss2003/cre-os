import { describe, expect, it } from "vitest";
import { parseMarkdown, parseInline, markdownToPlain } from "./markdown";
import { focusFromPath } from "./focus";

describe("markdown renderer", () => {
  it("parses paragraphs, headings, lists and code", () => {
    const b = parseMarkdown("# Title\n\nHello **world**\nnext line\n\n- a\n- b\n\n1. one\n2. two\n\n```\nx < y\n```");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "code"]);
    expect(b[1]).toEqual({ t: "p", c: [{ t: "text", v: "Hello " }, { t: "bold", c: [{ t: "text", v: "world" }] }, { t: "text", v: " next line" }] });
    expect(b[4]).toEqual({ t: "code", v: "x < y" });
  });
  it("only allows safe links", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "x" }, { t: "text", v: ")" }]);
    expect(parseInline("[ok](https://a.com)")[0]).toMatchObject({ t: "link", href: "https://a.com", external: true });
    expect(parseInline("[in](/companies/1)")[0]).toMatchObject({ t: "link", external: false });
    expect(parseInline("[p](//evil.com)")[0]).toEqual({ t: "text", v: "p" });
  });
  it("keeps html as plain text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<img src=x onerror=alert(1)>" }]);
  });
  it("strips to plain text", () => {
    expect(markdownToPlain("**a** and `b`\n\n- c")).toBe("a and b\n\n- c");
  });
});

describe("focusFromPath", () => {
  it("maps record routes", () => {
    expect(focusFromPath("/companies/abc")).toEqual({ type: "company", id: "abc", href: "/companies/abc" });
    expect(focusFromPath("/people/p1/edit")?.type).toBe("person");
    expect(focusFromPath("/buildings/b1")?.type).toBe("asset");
    expect(focusFromPath("/deals/d1")?.type).toBe("opportunity");
    expect(focusFromPath("/meetings/m1")?.type).toBe("meeting");
    expect(focusFromPath("/toolkit/compare/c9")).toEqual({ type: "analysis", id: "c9", href: "/toolkit/compare/c9" });
  });
  it("ignores lists and new forms", () => {
    expect(focusFromPath("/companies")).toBeNull();
    expect(focusFromPath("/companies/new")).toBeNull();
    expect(focusFromPath("/toolkit/compare/new")).toBeNull();
    expect(focusFromPath("/home")).toBeNull();
    expect(focusFromPath(null)).toBeNull();
  });
});
