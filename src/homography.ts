/**
 * Planar homography between image pixels and the road surface, in metres.
 *
 * A camera looking at a flat road is a projective map between two planes, so four point
 * correspondences fully determine it. That is the whole reason we ask for four measured points
 * rather than a single scale factor: a single scale is only correct when the camera looks
 * perpendicularly across the street, and is badly wrong the moment the view is angled down the road.
 */

/** A 3x3 homography in row-major order. */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

export type Point = readonly [number, number];

/**
 * Solve the homography mapping `src` onto `dst` from exactly four correspondences.
 *
 * Each correspondence contributes two rows to an 8x8 linear system in the eight free parameters
 * (h33 is fixed at 1), which we solve directly by Gaussian elimination with partial pivoting. With
 * only four points the system is square, so there is no least-squares step and no need for an SVD.
 *
 * @throws When fewer than four points are given, or the points are degenerate (three collinear, or
 *   two coincident), which makes the system singular.
 */
export function solveHomography(src: readonly Point[], dst: readonly Point[]): Matrix3 {
  if((src.length !== 4) || (dst.length !== 4)) {
    throw new Error("A homography needs exactly 4 point correspondences, got " + src.length + " and " + dst.length + ".");
  }

  const a: number[][] = [];

  for(let i = 0; i < 4; i++) {
    const [ x, y ] = src[i] as Point;
    const [ u, v ] = dst[i] as Point;

    a.push([ x, y, 1, 0, 0, 0, -u * x, -u * y, u ]);
    a.push([ 0, 0, 0, x, y, 1, -v * x, -v * y, v ]);
  }

  const h = solveLinearSystem(a);

  return [ h[0] as number, h[1] as number, h[2] as number, h[3] as number, h[4] as number, h[5] as number,
    h[6] as number, h[7] as number, 1 ];
}

/** Project a point through a homography. */
export function applyHomography(h: Matrix3, point: Point): Point {
  const [ x, y ] = point;
  const w = (h[6] * x) + (h[7] * y) + h[8];

  // A near-zero w means the point sits on the horizon line, where the projection is undefined and
  // the result would be a meaningless enormous number. Surface it rather than emit garbage.
  if(Math.abs(w) < 1e-12) {
    throw new Error("Point [" + x + ", " + y + "] projects to infinity - it lies on the horizon of this homography.");
  }

  return [ (((h[0] * x) + (h[1] * y) + h[2]) / w), (((h[3] * x) + (h[4] * y) + h[5]) / w) ];
}

/** Invert a homography. Used to warp the ground-plane verification grid back onto the image. */
export function invertHomography(h: Matrix3): Matrix3 {
  const [ a, b, c, d, e, f, g, i, j ] = h;

  const c00 = (e * j) - (f * i);
  const c01 = (f * g) - (d * j);
  const c02 = (d * i) - (e * g);
  const det = (a * c00) + (b * c01) + (c * c02);

  if(Math.abs(det) < 1e-12) {
    throw new Error("Homography is singular and cannot be inverted.");
  }

  const adj: number[] = [
    c00, (c * i) - (b * j), (b * f) - (c * e),
    c01, (a * j) - (c * g), (c * d) - (a * f),
    c02, (b * g) - (a * i), (a * e) - (b * d)
  ];

  // Normalise so the last element is 1, matching the convention solveHomography produces.
  const scale = 1 / (adj[8] as number);

  return adj.map((v) => v * scale) as unknown as Matrix3;
}

/** Solve `A x = b` where each row of `rows` is `[...coefficients, b]`. Gaussian elimination, partial pivoting. */
function solveLinearSystem(rows: number[][]): number[] {
  const n = rows.length;
  const m = rows.map((r) => r.slice());

  for(let col = 0; col < n; col++) {
    let pivot = col;

    for(let r = col + 1; r < n; r++) {
      if(Math.abs((m[r] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) {
        pivot = r;
      }
    }

    if(Math.abs((m[pivot] as number[])[col] as number) < 1e-12) {
      throw new Error("Degenerate calibration points: the four points must not be collinear or coincident.");
    }

    [ m[col], m[pivot] ] = [ m[pivot] as number[], m[col] as number[] ];

    const pivotRow = m[col] as number[];
    const pivotValue = pivotRow[col] as number;

    for(let r = 0; r < n; r++) {
      if(r === col) {
        continue;
      }

      const row = m[r] as number[];
      const factor = (row[col] as number) / pivotValue;

      if(factor === 0) {
        continue;
      }

      for(let c = col; c <= n; c++) {
        row[c] = (row[c] as number) - (factor * (pivotRow[c] as number));
      }
    }
  }

  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** Ray-casting point-in-polygon test. Used for the road ROI and the calibration-quad margin check. */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  const [ x, y ] = point;
  let inside = false;

  for(let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ xi, yi ] = polygon[i] as Point;
    const [ xj, yj ] = polygon[j] as Point;

    if(((yi > y) !== (yj > y)) && (x < (((xj - xi) * (y - yi)) / (yj - yi)) + xi)) {
      inside = !inside;
    }
  }

  return inside;
}

/** Shortest distance from a point to a polygon's boundary, in the polygon's own units. */
export function distanceToPolygon(point: Point, polygon: readonly Point[]): number {
  let best = Infinity;

  for(let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    best = Math.min(best, distanceToSegment(point, polygon[j] as Point, polygon[i] as Point));
  }

  return best;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = (dx * dx) + (dy * dy);

  if(lengthSquared === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }

  const t = Math.max(0, Math.min(1, (((p[0] - a[0]) * dx) + ((p[1] - a[1]) * dy)) / lengthSquared));

  return Math.hypot(p[0] - (a[0] + (t * dx)), p[1] - (a[1] + (t * dy)));
}

/**
 * Signed-area ordering check. The calibration UI lets a user click four points in any order, but a
 * homography onto a self-intersecting "bowtie" quad is nonsense, so the caller reorders or rejects.
 */
export function isConvexQuad(quad: readonly Point[]): boolean {
  if(quad.length !== 4) {
    return false;
  }

  let sign = 0;

  for(let i = 0; i < 4; i++) {
    const a = quad[i] as Point;
    const b = quad[(i + 1) % 4] as Point;
    const c = quad[(i + 2) % 4] as Point;
    const cross = ((b[0] - a[0]) * (c[1] - b[1])) - ((b[1] - a[1]) * (c[0] - b[0]));

    if(cross !== 0) {
      if(sign === 0) {
        sign = Math.sign(cross);
      } else if(Math.sign(cross) !== sign) {
        return false;
      }
    }
  }

  return sign !== 0;
}
