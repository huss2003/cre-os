import { describe, it, expect } from "vitest";
import { containsLike, escapeLike } from "./like";

describe("escapeLike", () => {
  it("escapes LIKE wildcards and backslash", () => {
    expect(escapeLike("50% Realty")).toBe("50\\% Realty");
    expect(escapeLike("A_B Corp")).toBe("A\\_B Corp");
    expect(escapeLike("C:\\x")).toBe("C:\\\\x");
    expect(escapeLike("Plain")).toBe("Plain");
    expect(containsLike("a%")).toBe("%a\\%%");
  });
});
