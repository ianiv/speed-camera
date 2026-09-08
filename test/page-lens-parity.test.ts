import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLens, distortPoint, solveLens, undistortPoint } from "../src/lens.js";
import type { Point } from "../src/homography.js";

/**
 * The calibration page reimplements the lens maths in browser JavaScript, so that what the user
 * sees while clicking is the same projection the measurement will later use. Two implementations
 * of one formula drift, and the failure mode is silent: the grid would look right on screen while
 * every recorded speed came out wrong. This test runs the page's own source and holds it to the
 * TypeScript module.
 */
function loadPageLens(width: number, height: number) {
  const html = readFileSync(resolve(import.meta.dirname, "../src/calibrate/page.html"), "utf8");
  const start = html.indexOf("function lensDefaults()");
  const end = html.indexOf("/* --- geometry: mirrors src/homography.ts");

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const source = html.slice(start, end);
  const factory = new Function("canvas",
    "let lens = null;\n" + source +
    "\nreturn { lensDefaults, undistort, distort, straightness, solveLensFrom };");

  return factory({ height, width }) as {
    lensDefaults: () => Record<string, number>;
    undistort: (p: Point, l: unknown) => Point;
    distort: (p: Point, l: unknown) => Point;
    straightness: (pts: Point[]) => number;
    solveLensFrom: (lines: Point[][]) => { lens: Record<string, number>; before: number; after: number } | null;
  };
}

const W = 3840;
const H = 2160;
const page = loadPageLens(W, H);
const lens = { ...defaultLens(W, H), k1: 0.23, k2: -0.05 };

describe("calibration page lens maths", () => {
  it("uses the same normalisation as the module", () => {
    expect(page.lensDefaults()).toEqual(defaultLens(W, H));
  });

  it("undistorts identically to src/lens.ts", () => {
    for(const p of [ [ 0, 0 ], [ 3839, 2159 ], [ 1920, 1080 ], [ 500, 1700 ], [ 3200, 400 ] ] as Point[]) {
      const mine = undistortPoint(lens, p);
      const theirs = page.undistort(p, lens);

      expect(theirs[0]).toBeCloseTo(mine[0], 9);
      expect(theirs[1]).toBeCloseTo(mine[1], 9);
    }
  });

  it("distorts identically to src/lens.ts", () => {
    for(const p of [ [ 100, 200 ], [ 3700, 2000 ], [ 1920, 300 ] ] as Point[]) {
      const mine = distortPoint(lens, p);
      const theirs = page.distort(p, lens);

      expect(theirs[0]).toBeCloseTo(mine[0], 6);
      expect(theirs[1]).toBeCloseTo(mine[1], 6);
    }
  });

  it("solves to the same coefficients as the module", () => {
    const straight = (from: Point, to: Point, n = 9): Point[] => Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);

      return [ from[0] + ((to[0] - from[0]) * t), from[1] + ((to[1] - from[1]) * t) ] as Point;
    });

    const lines = [ straight([ 150, 450 ], [ 3690, 560 ]), straight([ 150, 1650 ], [ 3690, 1560 ]) ]
      .map((line) => line.map((p) => distortPoint(lens, p)));

    const mine = solveLens(lines, W, H);
    const theirs = page.solveLensFrom(lines as Point[][]);

    expect(theirs).not.toBeNull();
    expect((theirs as { lens: { k1: number } }).lens.k1).toBeCloseTo(mine.lens.k1, 6);
    expect((theirs as { lens: { k2: number } }).lens.k2).toBeCloseTo(mine.lens.k2, 6);
  });
});
