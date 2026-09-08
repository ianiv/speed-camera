import { describe, expect, it } from "vitest";
import { applyHomography, invertHomography, solveHomography } from "../src/homography.js";
import type { Point } from "../src/homography.js";
import { defaultLens, distortPoint } from "../src/lens.js";
import type { LensModel } from "../src/lens.js";
import { buildFitContext, measureTrack } from "../src/speed.js";
import type { Calibration, Track, TrackPoint } from "../src/types.js";
import { loadConfigDefaults } from "./helpers.js";

const W = 3840;
const H = 2160;
const CFG = loadConfigDefaults().speed;

// Roughly the real camera: a wide lens with noticeable barrel distortion.
const LENS: LensModel = { ...defaultLens(W, H), k1: 0.25, k2: 0 };

const IDEAL_IMAGE: [Point, Point, Point, Point] = [ [ 400, 1500 ], [ 3400, 1500 ], [ 2900, 700 ], [ 900, 700 ] ];
const GROUND: [Point, Point, Point, Point] = [ [ 0, 0 ], [ 24, 0 ], [ 24, 9 ], [ 0, 9 ] ];

/** The same four road points as the camera actually records them, i.e. bent by the lens. */
const OBSERVED_IMAGE = IDEAL_IMAGE.map((p) => distortPoint(LENS, p)) as [Point, Point, Point, Point];

const CORRECTED: Calibration = {
  cameraId: "c", createdAt: new Date(0).toISOString(), groundPoints: GROUND,
  imageHeight: H, imagePoints: OBSERVED_IMAGE, imageWidth: W, lens: LENS,
  roi: [ [ 0, 0 ], [ W, 0 ], [ W, H ], [ 0, H ] ]
};

/** Identical, except it pretends the camera is rectilinear - what we shipped before. */
const UNCORRECTED: Calibration = { ...CORRECTED, lens: undefined as unknown as LensModel };

/**
 * A car at constant speed on the ground, rendered into the image exactly as this camera would:
 * ideal pinhole projection, then bent by the lens.
 */
function drive(speedMps: number, y: number, frames = 26, fps = 24): Track {
  const inverse = invertHomography(solveHomography(IDEAL_IMAGE, GROUND));
  const points: TrackPoint[] = [];

  for(let i = 0; i < frames; i++) {
    const t = i / fps;
    const ideal = applyHomography(inverse, [ 2 + (speedMps * t), y ] as Point);
    const [ px, py ] = distortPoint(LENS, ideal);

    points.push({ bbox: [ px - 130, py - 200, px + 130, py ], conf: 0.9, frame: i, t });
  }

  return { cls: "car", points, trackId: 1 };
}

function measure(track: Track, calibration: Calibration) {
  return measureTrack(track, buildFitContext(calibration, W, H, "pts"), CFG);
}

describe("lens correction end to end", () => {
  it("recovers the true speed once the lens is accounted for", () => {
    for(const kph of [ 30, 50, 70 ]) {
      const result = measure(drive(kph / 3.6, 4.5), CORRECTED);

      expect(result.rejectedReason).toBeNull();
      expect(result.speedKph).toBeCloseTo(kph, 4);
    }
  });

  it("is materially wrong when the lens is ignored", () => {
    // The point of the whole exercise: assuming a pinhole camera on a wide lens does not produce a
    // slightly noisy answer, it produces a confidently wrong one.
    const truth = 50;
    const naive = measure(drive(truth / 3.6, 4.5), UNCORRECTED);
    const corrected = measure(drive(truth / 3.6, 4.5), CORRECTED);

    expect(Math.abs(corrected.speedKph - truth)).toBeLessThan(0.05);
    expect(Math.abs(naive.speedKph - truth)).toBeGreaterThan(2);
  });

  it("makes a constant-speed pass look like it changed speed, which the fit gate then sees", () => {
    // Distortion varies across the frame, so an unmodelled lens turns a steady car into an
    // apparently accelerating one - the r2 gate catches it, at the cost of discarding good passes.
    const track = drive(50 / 3.6, 4.5, 34);

    expect(measure(track, CORRECTED).r2).toBeGreaterThan(measure(track, UNCORRECTED).r2);
    expect(measure(track, CORRECTED).r2).toBeGreaterThan(0.9999);
  });

  it("gives the same speed in the near and far lane, as it must", () => {
    const near = measure(drive(50 / 3.6, 2), CORRECTED);
    const far = measure(drive(50 / 3.6, 7), CORRECTED);

    expect(near.speedKph).toBeCloseTo(50, 4);
    expect(far.speedKph).toBeCloseTo(50, 4);
  });
});
