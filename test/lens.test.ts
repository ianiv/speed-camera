import { describe, expect, it } from "vitest";
import { defaultLens, distortPoint, solveLens, straightnessCost, undistortPoint } from "../src/lens.js";
import type { LensModel } from "../src/lens.js";
import type { Point } from "../src/homography.js";

const W = 3840;
const H = 2160;

/** Apply a known barrel distortion, so the solver has a right answer to be judged against. */
function bend(k1: number, k2: number): (p: Point) => Point {
  const lens: LensModel = { ...defaultLens(W, H), k1, k2 };

  return (p) => distortPoint(lens, p);
}

/** A straight line in the world, sampled evenly. */
function straightLine(from: Point, to: Point, n = 9): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);

    return [ from[0] + ((to[0] - from[0]) * t), from[1] + ((to[1] - from[1]) * t) ] as Point;
  });
}

describe("undistort/distort", () => {
  const lens: LensModel = { ...defaultLens(W, H), k1: 0.18, k2: -0.04 };

  it("round-trips to sub-pixel accuracy across the frame", () => {
    for(const p of [ [ 10, 10 ], [ 3830, 2150 ], [ 1920, 1080 ], [ 200, 1800 ], [ 3600, 300 ] ] as Point[]) {
      const back = distortPoint(lens, undistortPoint(lens, p));

      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
  });

  it("leaves the optical centre fixed", () => {
    expect(undistortPoint(lens, [ W / 2, H / 2 ])).toEqual([ W / 2, H / 2 ]);
  });

  it("moves edge pixels far more than central ones", () => {
    const near = undistortPoint(lens, [ (W / 2) + 100, H / 2 ]);
    const far = undistortPoint(lens, [ W - 10, H / 2 ]);

    expect(Math.abs(near[0] - ((W / 2) + 100))).toBeLessThan(2);
    expect(Math.abs(far[0] - (W - 10))).toBeGreaterThan(100);
  });

  it("is a no-op when the model is identity", () => {
    const flat = defaultLens(W, H);

    expect(undistortPoint(flat, [ 123, 456 ])).toEqual([ 123, 456 ]);
    expect(undistortPoint(undefined, [ 123, 456 ])).toEqual([ 123, 456 ]);
  });
});

describe("straightnessCost", () => {
  it("is zero for collinear points", () => {
    expect(straightnessCost(straightLine([ 0, 0 ], [ 100, 50 ]))).toBeCloseTo(0, 12);
  });

  it("grows with curvature", () => {
    const bowed = straightLine([ 0, 0 ], [ 100, 0 ]).map(([ x ], i) => [ x, Math.sin((i / 8) * Math.PI) * 5 ] as Point);

    expect(straightnessCost(bowed)).toBeGreaterThan(0.001);
  });

  it("is unchanged by uniform scaling, so a shrinking solution gains nothing", () => {
    const bowed = straightLine([ 0, 0 ], [ 100, 0 ]).map(([ x ], i) => [ x, Math.sin((i / 8) * Math.PI) * 5 ] as Point);
    const shrunk = bowed.map(([ x, y ]) => [ x * 0.01, y * 0.01 ] as Point);

    expect(straightnessCost(shrunk)).toBeCloseTo(straightnessCost(bowed), 10);
  });
});

describe("solveLens", () => {
  it("recovers a known barrel distortion from traced lines", () => {
    const distort = bend(0.20, -0.05);
    // Lines spread across the frame, as a user would trace a kerb and a roofline.
    const lines = [
      straightLine([ 100, 400 ], [ 3740, 500 ]),
      straightLine([ 100, 1700 ], [ 3740, 1600 ]),
      straightLine([ 300, 100 ], [ 500, 2060 ])
    ].map((line) => line.map(distort));

    const solved = solveLens(lines, W, H);

    expect(solved.costAfter).toBeLessThan(solved.costBefore);
    expect(solved.costAfter).toBeLessThan(1e-6);

    // The real test is not the coefficients but whether the lines come out straight.
    for(const line of lines) {
      expect(straightnessCost(line.map((p) => undistortPoint(solved.lens, p)))).toBeLessThan(1e-6);
    }
  });

  it("straightens points to within a pixel of where they belong", () => {
    const truth = straightLine([ 200, 600 ], [ 3600, 900 ], 11);
    const distorted = truth.map(bend(0.22, 0));
    const solved = solveLens([ distorted ], W, H);

    for(const [ i, p ] of distorted.entries()) {
      const fixed = undistortPoint(solved.lens, p);

      expect(Math.hypot(fixed[0] - (truth[i] as Point)[0], fixed[1] - (truth[i] as Point)[1])).toBeLessThan(1);
    }
  });

  it("returns essentially no correction for an already-rectilinear camera", () => {
    const lines = [ straightLine([ 100, 400 ], [ 3740, 500 ]), straightLine([ 100, 1700 ], [ 3740, 1600 ]) ];
    const solved = solveLens(lines, W, H);

    expect(Math.abs(solved.lens.k1)).toBeLessThan(0.02);
  });

  it("refuses to guess from too little evidence", () => {
    expect(() => solveLens([ [ [ 0, 0 ], [ 1, 1 ] ] ], W, H)).toThrow(/3 or more points/);
  });
});
