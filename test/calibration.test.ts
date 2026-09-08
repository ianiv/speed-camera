import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCalibration, rectangleGround, saveCalibration, validate } from "../src/calibration.js";
import { eventUrl } from "../src/links.js";
import type { Calibration } from "../src/types.js";

const GOOD: Calibration = {
  cameraId: "cam1",
  createdAt: new Date(0).toISOString(),
  groundPoints: [ [ 0, 0 ], [ 10, 0 ], [ 10, 20 ], [ 0, 20 ] ],
  imageHeight: 1080,
  imagePoints: [ [ 180, 980 ], [ 1180, 470 ], [ 1810, 520 ], [ 320, 1060 ] ],
  imageWidth: 1920,
  roi: [ [ 0, 300 ], [ 1920, 300 ], [ 1920, 1080 ], [ 0, 1080 ] ]
};

describe("calibration validation", () => {
  it("accepts a well-formed calibration", () => {
    expect(() => validate(GOOD)).not.toThrow();
  });

  it("rejects image points clicked diagonally across the quad", () => {
    // The most likely user error: clicking opposite corners in sequence. It produces a bowtie whose
    // homography is nonsense, so it has to fail at save time rather than a week of readings later.
    expect(() => validate({ ...GOOD,
      imagePoints: [ GOOD.imagePoints[0], GOOD.imagePoints[2], GOOD.imagePoints[1], GOOD.imagePoints[3] ] }))
      .toThrow(/self-intersecting/);
  });

  it("rejects ground points ordered differently from the image points", () => {
    expect(() => validate({ ...GOOD, groundPoints: [ [ 0, 0 ], [ 10, 20 ], [ 10, 0 ], [ 0, 20 ] ] }))
      .toThrow(/self-intersecting/);
  });

  it("rejects collinear image points", () => {
    expect(() => validate({ ...GOOD, imagePoints: [ [ 0, 0 ], [ 10, 10 ], [ 20, 20 ], [ 30, 30 ] ] }))
      .toThrow();
  });

  it("round-trips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ufp-calib-"));
    const path = join(dir, "calibration.json");

    try {
      saveCalibration(GOOD, path);
      expect(loadCalibration(path)).toEqual(GOOD);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("explains itself when the file is missing", () => {
    expect(() => loadCalibration("/nonexistent/calibration.json")).toThrow(/calibrate/);
  });

  it("rejects a malformed file rather than silently using defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "ufp-calib-"));
    const path = join(dir, "calibration.json");

    try {
      saveCalibration({ ...GOOD }, path);
      rmSync(path);
      expect(() => loadCalibration(path)).toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("builds rectangle ground points in the clicked corner order", () => {
    expect(rectangleGround(9, 22)).toEqual([ [ 0, 0 ], [ 9, 0 ], [ 9, 22 ], [ 0, 22 ] ]);
  });
});

describe("eventUrl", () => {
  const ctx = { cameraId: "cam1", endMs: 2000, eventId: "abc123", host: "192.168.1.1", startMs: 1000 };

  it("substitutes every placeholder", () => {
    expect(eventUrl("https://{host}/protect/events/{eventId}", ctx))
      .toBe("https://192.168.1.1/protect/events/abc123");
    expect(eventUrl("https://{host}/protect/timelapse/{cameraId}?start={startMs}&end={endMs}", ctx))
      .toBe("https://192.168.1.1/protect/timelapse/cam1?start=1000&end=2000");
  });

  it("escapes ids so an odd id cannot break out of the URL", () => {
    expect(eventUrl("https://{host}/e/{eventId}", { ...ctx, eventId: "a b&c" }))
      .toBe("https://192.168.1.1/e/a%20b%26c");
  });
});
