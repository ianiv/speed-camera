import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildFitContext, measureTrack } from "../src/speed.js";
import type { Calibration, WorkerResult } from "../src/types.js";
import { loadConfigDefaults } from "./helpers.js";

/**
 * Captured from a real `py/worker.py` run over real footage. Its purpose is to fail loudly if the
 * Python side's output shape ever drifts from what the TypeScript side reads - the two runtimes
 * share nothing but this JSON, so nothing else would catch it.
 */
const RESULT = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/worker-output.json"), "utf8")) as WorkerResult;

const CFG = loadConfigDefaults();

describe("worker output contract", () => {
  it("carries the fields the pipeline reads", () => {
    expect(RESULT).toMatchObject({
      fps: expect.any(Number), height: expect.any(Number),
      timing: expect.stringMatching(/^(pts|nominal)$/), width: expect.any(Number)
    });
    expect(RESULT.tracks.length).toBeGreaterThan(0);
  });

  it("gives every track point a timestamp, a box, and a confidence", () => {
    for(const track of RESULT.tracks) {
      expect(typeof track.trackId).toBe("number");
      expect(typeof track.cls).toBe("string");
      expect(track.points.length).toBeGreaterThan(0);

      for(const point of track.points) {
        expect(Number.isFinite(point.t)).toBe(true);
        expect(point.bbox).toHaveLength(4);
        expect(point.bbox.every(Number.isFinite)).toBe(true);
        expect(point.conf).toBeGreaterThan(0);
        expect(point.conf).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reports timestamps in increasing order within a track", () => {
    for(const track of RESULT.tracks) {
      const times = track.points.map((p) => p.t);

      expect(times).toEqual([ ...times ].sort((a, b) => a - b));
    }
  });

  it("only reports vehicle classes", () => {
    const vehicles = new Set([ "car", "motorcycle", "bus", "truck" ]);

    for(const track of RESULT.tracks) {
      expect(vehicles.has(track.cls)).toBe(true);
    }
  });

  it("feeds through the measurement path without throwing", () => {
    const calibration: Calibration = {
      cameraId: "fixture",
      createdAt: new Date(0).toISOString(),
      groundPoints: [ [ 0, 0 ], [ 12, 0 ], [ 12, 25 ], [ 0, 25 ] ],
      imageHeight: RESULT.height,
      imagePoints: [ [ 40, 400 ], [ 730, 400 ], [ 600, 120 ], [ 170, 120 ] ],
      imageWidth: RESULT.width,
      roi: [ [ 0, 0 ], [ RESULT.width, 0 ], [ RESULT.width, RESULT.height ], [ 0, RESULT.height ] ]
    };

    const ctx = buildFitContext(calibration, RESULT.width, RESULT.height, RESULT.timing);
    const measurements = RESULT.tracks.map((t) => measureTrack(t, ctx, CFG.speed));

    expect(measurements).toHaveLength(RESULT.tracks.length);

    // This footage is a car park: every track is a handful of frames of a mostly-parked car, so the
    // gates should reject all of them. Silence here would mean the gates are not actually running.
    expect(measurements.every((m) => m.rejectedReason !== null)).toBe(true);
    expect(measurements.every((m) => m.trackId !== undefined)).toBe(true);
  });
});
