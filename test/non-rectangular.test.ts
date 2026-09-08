import { describe, expect, it } from "vitest";
import { applyHomography, invertHomography, solveHomography } from "../src/homography.js";
import type { Point } from "../src/homography.js";
import { buildFitContext, measureTrack } from "../src/speed.js";
import { createProjector, validate } from "../src/calibration.js";
import type { Calibration, Track, TrackPoint } from "../src/types.js";
import { loadConfigDefaults } from "./helpers.js";

const W = 3840;
const H = 2160;
const CFG = loadConfigDefaults().speed;

const IMAGE: [Point, Point, Point, Point] = [ [ 400, 1500 ], [ 3400, 1500 ], [ 2900, 700 ], [ 900, 700 ] ];

/**
 * The four calibration points do not have to form a rectangle, and on a real road they usually
 * cannot: kerbs curve, corners are not square, and the features you can actually measure sit where
 * they sit. Only the ground coordinates need to be known.
 */
const SHAPES: Record<string, [Point, Point, Point, Point]> = {
  // A trapezoid: the far kerb is further apart than the near one, as on a widening road.
  trapezoid: [ [ 0, 0 ], [ 9, 0 ], [ 12.5, 21 ], [ -1.5, 21 ] ],
  // A parallelogram: the cross-road pairs are offset along the road, as when a kerb curves.
  parallelogram: [ [ 0, 0 ], [ 9, 0 ], [ 11, 20 ], [ 2, 20 ] ],
  // Four independently measured features with no particular relationship.
  irregular: [ [ 0.4, 0.2 ], [ 9.1, -0.6 ], [ 10.8, 19.4 ], [ 1.3, 20.7 ] ],
  rectangle: [ [ 0, 0 ], [ 9, 0 ], [ 9, 20 ], [ 0, 20 ] ]
};

function calibration(ground: [Point, Point, Point, Point]): Calibration {
  return { cameraId: "c", createdAt: new Date(0).toISOString(), groundPoints: ground, imageHeight: H,
    imagePoints: IMAGE, imageWidth: W, roi: [ [ 0, 0 ], [ W, 0 ], [ W, H ], [ 0, H ] ] };
}

/** Drive along the ground at a constant speed, seen through the calibration's own geometry. */
function drive(cal: Calibration, kph: number, from: Point, to: Point, frames = 24): Track {
  const inverse = invertHomography(solveHomography(IMAGE, cal.groundPoints));
  const spanM = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const seconds = spanM / (kph / 3.6);
  const points: TrackPoint[] = [];

  for(let i = 0; i < frames; i++) {
    const f = i / (frames - 1);
    const [ px, py ] = applyHomography(inverse,
      [ from[0] + ((to[0] - from[0]) * f), from[1] + ((to[1] - from[1]) * f) ] as Point);

    points.push({ bbox: [ px - 120, py - 190, px + 120, py ], conf: 0.9, frame: i, t: f * seconds });
  }

  return { cls: "car", points, trackId: 1 };
}

describe("non-rectangular calibration quads", () => {
  for(const [ name, ground ] of Object.entries(SHAPES)) {
    it("recovers the true speed with a " + name + " quad", () => {
      const cal = calibration(ground);
      const track = drive(cal, 50, [ 1, 6 ], [ 8, 14 ]);
      const result = measureTrack(track, buildFitContext(cal, W, H, "pts"), CFG);

      expect(result.rejectedReason).toBeNull();
      expect(result.speedKph).toBeCloseTo(50, 3);
    });
  }

  it("reproduces every ground point exactly, whatever the shape", () => {
    for(const ground of Object.values(SHAPES)) {
      const { toGround } = createProjector(calibration(ground));

      for(const [ i, expected ] of ground.entries()) {
        const got = toGround(IMAGE[i] as Point);

        expect(got[0]).toBeCloseTo(expected[0], 9);
        expect(got[1]).toBeCloseTo(expected[1], 9);
      }
    }
  });

  it("still refuses a self-crossing ground quad", () => {
    // Generality is not permission to be inconsistent: ground points listed in a different order
    // than the clicks contradict the picture, and would solve to a confident nonsense. The guard
    // sits at the boundary - every calibration passes through validate() on save and on load.
    const bowtie = calibration([ [ 0, 0 ], [ 9, 20 ], [ 9, 0 ], [ 0, 20 ] ]);

    expect(() => validate(bowtie)).toThrow(/self-intersecting/);
  });

  it("accepts every shape the UI can produce", () => {
    for(const ground of Object.values(SHAPES)) {
      expect(() => validate(calibration(ground))).not.toThrow();
    }
  });
});
