import { describe, expect, it } from "vitest";
import { API, describe as describeError, resolveUrl } from "../src/protect.js";

describe("resolveUrl", () => {
  it("makes an API path absolute", () => {
    // Regression: a bare path reaches undici as ERR_INVALID_URL, which the library reports only as
    // "a network error occurred" - indistinguishable from an unreachable controller.
    expect(resolveUrl("192.168.1.1", API + "/bootstrap"))
      .toBe("https://192.168.1.1/proxy/protect/api/bootstrap");
  });

  it("leaves an already-absolute URL alone", () => {
    expect(resolveUrl("192.168.1.1", "https://elsewhere/x")).toBe("https://elsewhere/x");
  });

  it("produces a URL the WHATWG parser accepts", () => {
    expect(() => new URL(resolveUrl("192.168.1.1", API + "/video/export?camera=abc"))).not.toThrow();
    expect(() => new URL(API + "/video/export")).toThrow();
  });
});

describe("describe", () => {
  it("flattens a cause chain, which is where the real fault lives", () => {
    const root = Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" });
    const wrapped = new Error("A network error occurred.", { cause: root });

    expect(describeError(wrapped)).toBe("A network error occurred. <- Invalid URL [ERR_INVALID_URL]");
  });

  it("handles an error with no cause", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
  });
});
