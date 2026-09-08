import { describe, expect, it } from "vitest";
import { parseByteRange } from "../src/dashboard/clips.js";

const SIZE = 1000;

describe("parseByteRange", () => {
  it("treats a missing or empty header as the whole body", () => {
    expect(parseByteRange(undefined, SIZE)).toBe("whole");
    expect(parseByteRange("", SIZE)).toBe("whole");
  });

  it("ignores a header it does not understand rather than guessing", () => {
    // Multi-range and non-byte units are legal HTTP that this does not implement. Serving the whole
    // body is always a correct answer to a range request; inventing an offset is not.
    expect(parseByteRange("bytes=0-99,200-299", SIZE)).toBe("whole");
    expect(parseByteRange("items=0-99", SIZE)).toBe("whole");
    expect(parseByteRange("bytes=-", SIZE)).toBe("whole");
  });

  it("returns an inclusive range", () => {
    // The classic off-by-one: bytes=0-99 is 100 bytes, and Content-Range says 0-99/1000.
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ end: 99, start: 0 });
  });

  it("runs an open-ended range to the last byte", () => {
    expect(parseByteRange("bytes=500-", SIZE)).toEqual({ end: 999, start: 500 });
  });

  it("counts a suffix range back from the end", () => {
    expect(parseByteRange("bytes=-500", SIZE)).toEqual({ end: 999, start: 500 });
  });

  it("clamps a suffix longer than the body to the whole body", () => {
    expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ end: 999, start: 0 });
  });

  it("clamps an end past the last byte", () => {
    // Browsers routinely ask for more than exists when probing a file's length.
    expect(parseByteRange("bytes=900-99999", SIZE)).toEqual({ end: 999, start: 900 });
  });

  it("rejects a start at or past the end of the body", () => {
    expect(parseByteRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5000-6000", SIZE)).toBe("unsatisfiable");
  });

  it("rejects a backwards range", () => {
    expect(parseByteRange("bytes=500-100", SIZE)).toBe("unsatisfiable");
  });

  it("handles a single byte", () => {
    expect(parseByteRange("bytes=0-0", SIZE)).toEqual({ end: 0, start: 0 });
  });

  it("covers the whole body exactly when asked for all of it", () => {
    const range = parseByteRange("bytes=0-", SIZE);

    expect(range).toEqual({ end: 999, start: 0 });
    expect((range as { end: number; start: number }).end -
      (range as { end: number; start: number }).start + 1).toBe(SIZE);
  });
});
