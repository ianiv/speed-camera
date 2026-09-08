import { describe, expect, it } from "vitest";
import { applyHomography, invertHomography, isConvexQuad, pointInPolygon, solveHomography } from "../src/homography.js";
import type { Point } from "../src/homography.js";

const IMAGE: [Point, Point, Point, Point] = [ [ 100, 700 ], [ 1800, 700 ], [ 1500, 400 ], [ 400, 400 ] ];
const GROUND: [Point, Point, Point, Point] = [ [ 0, 0 ], [ 12, 0 ], [ 12, 20 ], [ 0, 20 ] ];

describe("solveHomography", () => {
  it("reproduces the four correspondences exactly", () => {
    const h = solveHomography(IMAGE, GROUND);

    for(let i = 0; i < 4; i++) {
      const [ x, y ] = applyHomography(h, IMAGE[i] as Point);

      expect(x).toBeCloseTo((GROUND[i] as Point)[0], 9);
      expect(y).toBeCloseTo((GROUND[i] as Point)[1], 9);
    }
  });

  it("round-trips through its inverse", () => {
    const h = solveHomography(IMAGE, GROUND);
    const inverse = invertHomography(h);

    for(const point of [ [ 640, 550 ], [ 1200, 480 ], [ 900, 690 ] ] as Point[]) {
      const [ x, y ] = applyHomography(inverse, applyHomography(h, point));

      expect(x).toBeCloseTo(point[0], 6);
      expect(y).toBeCloseTo(point[1], 6);
    }
  });

  it("is exactly a uniform scale when the view is perpendicular", () => {
    // The degenerate case the single-scalar approach assumes: a fronto-parallel view. A homography
    // must agree with it, otherwise perspective correction is introducing error rather than removing it.
    const h = solveHomography([ [ 0, 0 ], [ 1920, 0 ], [ 1920, 1080 ], [ 0, 1080 ] ],
      [ [ 0, 0 ], [ 19.2, 0 ], [ 19.2, 10.8 ], [ 0, 10.8 ] ]);
    const [ x, y ] = applyHomography(h, [ 960, 540 ]);

    expect(x).toBeCloseTo(9.6, 9);
    expect(y).toBeCloseTo(5.4, 9);
  });

  it("rejects collinear points", () => {
    expect(() => solveHomography([ [ 0, 0 ], [ 1, 1 ], [ 2, 2 ], [ 3, 3 ] ], GROUND))
      .toThrow(/collinear|singular|Degenerate/i);
  });

  it("rejects the wrong number of correspondences", () => {
    expect(() => solveHomography([ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ] ], GROUND)).toThrow(/exactly 4/);
  });
});

describe("pointInPolygon", () => {
  const square: Point[] = [ [ 0, 0 ], [ 10, 0 ], [ 10, 10 ], [ 0, 10 ] ];

  it("accepts interior points and rejects exterior ones", () => {
    expect(pointInPolygon([ 5, 5 ], square)).toBe(true);
    expect(pointInPolygon([ 15, 5 ], square)).toBe(false);
    expect(pointInPolygon([ -1, -1 ], square)).toBe(false);
  });
});

describe("isConvexQuad", () => {
  it("distinguishes a convex quad from a bowtie", () => {
    expect(isConvexQuad([ [ 0, 0 ], [ 10, 0 ], [ 10, 10 ], [ 0, 10 ] ])).toBe(true);
    expect(isConvexQuad([ [ 0, 0 ], [ 10, 10 ], [ 10, 0 ], [ 0, 10 ] ])).toBe(false);
  });
});
