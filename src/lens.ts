import type { Point } from "./homography.js";

/**
 * Radial lens distortion, and how to solve for it from the scene itself.
 *
 * A homography assumes a pinhole camera: straight lines in the world stay straight in the image.
 * A wide-angle camera breaks that assumption - a straight kerb bows - and the error grows with
 * distance from the optical centre. On a view where the road spans the full frame that is a
 * first-order error, not a refinement: it biases speed with position and makes a constant-speed
 * pass look like it accelerated, which the linear-fit gate then rejects.
 *
 * UniFi Protect exposes no intrinsics or distortion coefficients, so they are recovered from the
 * image using the plumb-line method: the user traces features that are known to be straight in
 * reality, and we search for the coefficients that make them straight in the picture.
 */
export interface LensModel {
  /** Quadratic radial term. Positive corrects barrel distortion. */
  k1: number;
  /** Quartic radial term, for the residual the quadratic cannot absorb. */
  k2: number;
  /** Optical centre in pixels. Defaults to the image centre. */
  cx: number;
  cy: number;
  /** Normalising radius in pixels - half the image width. Folds the unknown focal length into k1/k2. */
  s: number;
}

export function defaultLens(width: number, height: number): LensModel {
  return { cx: width / 2, cy: height / 2, k1: 0, k2: 0, s: width / 2 };
}

export function isIdentity(lens: LensModel | undefined): boolean {
  return !lens || ((lens.k1 === 0) && (lens.k2 === 0));
}

/** Radial scale factor at normalised radius `r`. */
function factor(lens: LensModel, rSquared: number): number {
  return 1 + (lens.k1 * rSquared) + (lens.k2 * rSquared * rSquared);
}

/**
 * Map a pixel as the camera recorded it to where a pinhole camera would have put it.
 *
 * This is the direction every measurement needs: detections come from the real, distorted image,
 * and the homography is only valid on undistorted coordinates.
 */
export function undistortPoint(lens: LensModel | undefined, point: Point): Point {
  if(isIdentity(lens)) {
    return point;
  }

  const l = lens as LensModel;
  const x = (point[0] - l.cx) / l.s;
  const y = (point[1] - l.cy) / l.s;
  const f = factor(l, (x * x) + (y * y));

  return [ l.cx + (x * f * l.s), l.cy + (y * f * l.s) ];
}

/**
 * The inverse: where a pinhole point actually lands in the recorded image.
 *
 * The forward model is a polynomial in radius, so inverting it means solving that polynomial.
 * Newton's method converges in a handful of iterations over the radii a real lens produces. Needed
 * only for drawing - the verification grid is computed in undistorted space and has to be drawn on
 * the distorted picture the user is actually looking at, following the same curve the lens imposes.
 */
export function distortPoint(lens: LensModel | undefined, point: Point): Point {
  if(isIdentity(lens)) {
    return point;
  }

  const l = lens as LensModel;
  const x = (point[0] - l.cx) / l.s;
  const y = (point[1] - l.cy) / l.s;
  const target = Math.hypot(x, y);

  if(target < 1e-12) {
    return point;
  }

  // Solve r * (1 + k1 r^2 + k2 r^4) = target for r.
  let r = target;

  for(let i = 0; i < 20; i++) {
    const rSquared = r * r;
    const value = (r * factor(l, rSquared)) - target;
    const derivative = 1 + (3 * l.k1 * rSquared) + (5 * l.k2 * rSquared * rSquared);

    if(Math.abs(derivative) < 1e-12) {
      break;
    }

    const step = value / derivative;

    r -= step;

    if(Math.abs(step) < 1e-12) {
      break;
    }
  }

  const scale = r / target;

  return [ l.cx + (x * scale * l.s), l.cy + (y * scale * l.s) ];
}

/**
 * How far a set of points departs from a straight line, as a scale-free ratio.
 *
 * Scale-free is the essential property. A cost measured in raw pixels would be minimised by any
 * coefficient that collapses the whole image toward the optical centre - the residuals shrink along
 * with everything else, and the solver happily reports a wildly distorting "solution". Dividing the
 * spread across the line by the spread along it removes that escape route: shrinking the points
 * changes both equally and the ratio does not move.
 *
 * The two spreads are the eigenvalues of the points' covariance, so this is one closed-form
 * expression rather than an explicit line fit.
 */
export function straightnessCost(points: readonly Point[]): number {
  const n = points.length;

  if(n < 3) {
    return 0;
  }

  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for(const p of points) {
    const dx = p[0] - mx;
    const dy = p[1] - my;

    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  sxx /= n;
  syy /= n;
  sxy /= n;

  const trace = sxx + syy;
  const det = (sxx * syy) - (sxy * sxy);
  const gap = Math.sqrt(Math.max(0, (trace * trace) - (4 * det)));
  const major = (trace + gap) / 2;
  const minor = (trace - gap) / 2;

  return (major <= 1e-12) ? 0 : Math.max(0, minor) / major;
}

export interface LensSolution {
  lens: LensModel;
  /** Mean straightness cost before and after, for reporting how much was actually corrected. */
  costBefore: number;
  costAfter: number;
}

/**
 * Recover radial coefficients from traced real-world-straight lines.
 *
 * A coarse-to-fine grid search rather than a gradient method: there are only two parameters, the
 * cost is cheap, and a grid cannot be trapped by the local minima this cost surface has near the
 * degenerate high-curvature corners. Roughly ten thousand evaluations, which is imperceptible.
 *
 * @param lines - Traced lines, each at least 3 points. Two lines in different parts of the frame
 *   constrain the fit far better than one.
 */
export function solveLens(lines: readonly (readonly Point[])[], width: number, height: number): LensSolution {
  const usable = lines.filter((line) => line.length >= 3);

  if(!usable.length) {
    throw new Error("Lens solving needs at least one traced line with 3 or more points. " +
      "Trace something you know is straight in real life, such as a kerb.");
  }

  const base = defaultLens(width, height);
  const cost = (k1: number, k2: number): number => {
    const lens: LensModel = { ...base, k1, k2 };

    return usable.reduce((total, line) =>
      total + straightnessCost(line.map((p) => undistortPoint(lens, p))), 0) / usable.length;
  };

  let best = { cost: cost(0, 0), k1: 0, k2: 0 };
  // Bounds comfortably cover consumer wide-angle lenses; beyond them the model stops being physical.
  let range = { k1: [ -0.6, 0.6 ], k2: [ -0.3, 0.3 ] };
  let steps = 60;

  for(let pass = 0; pass < 4; pass++) {
    const [ k1Low, k1High ] = range.k1 as [number, number];
    const [ k2Low, k2High ] = range.k2 as [number, number];
    const k1Step = (k1High - k1Low) / steps;
    const k2Step = (k2High - k2Low) / steps;

    for(let i = 0; i <= steps; i++) {
      for(let j = 0; j <= steps; j++) {
        const k1 = k1Low + (i * k1Step);
        const k2 = k2Low + (j * k2Step);
        const value = cost(k1, k2);

        if(value < best.cost) {
          best = { cost: value, k1, k2 };
        }
      }
    }

    // Narrow to the neighbourhood of the winner and search it more finely.
    range = { k1: [ best.k1 - k1Step, best.k1 + k1Step ], k2: [ best.k2 - k2Step, best.k2 + k2Step ] };
    steps = 20;
  }

  return {
    costAfter: best.cost,
    costBefore: cost(0, 0),
    lens: { ...base, k1: best.k1, k2: best.k2 }
  };
}
