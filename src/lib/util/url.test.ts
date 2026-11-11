import { describe, expect, it } from "vitest";
import { checkHttpUrl, isDomain, isHttpUrl } from "./url";

describe("url helpers", () => {
  it("accepts only http(s) links", () => {
    expect(isHttpUrl("https://linkedin.com/in/x")).toBe(true);
    expect(isHttpUrl("http://a.b/c?d=1")).toBe(true);
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://a.b", "linkedin.com/in/x", "https://"]) expect(isHttpUrl(bad)).toBe(false);
  });
  it("blank is unknown, not an error", () => {
    expect(checkHttpUrl("  ")).toEqual({ value: null, error: null });
    expect(checkHttpUrl("javascript:alert(1)", "Public profile URL").error).toMatch(/Public profile URL must be a web link/);
  });
  it("domains", () => {
    expect(isDomain("zentrix.co.in")).toBe(true);
    expect(isDomain("<b>x</b> 🚀")).toBe(false);
    expect(isDomain("https://a.com")).toBe(false);
  });
});
