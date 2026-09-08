import { distanceToPolygon, isConvexQuad, pointInPolygon } from "./homography.js";
import type { Point } from "./homography.js";
import { createProjector } from "./calibration.js";
import type { Calibration, SpeedMeasurement, TimingSource, Track, TrackPoint } from "./types.js";
import type { Config } from "./config.js";

const MPS_TO_KPH = 3.6;

/**
 * Residuals below this are never treated as outliers, however far they sit from the standard
 * deviation. On a cleanly tracked vehicle the spread of residuals is near zero, so a purely
 * relative test would keep discarding perfectly good points for being a few millimetres off the
 * fitted line. Real bounding-box jitter is tens of centimetres on the ground; this is well below it.
 */
const RESIDUAL_FLOOR_M = 0.05;
const MPS_TO_MPH = 2.236936292054402;

export interface FitContext {
  /** Image pixels to ground metres: lens correction then homography. */
  toGround: (imagePoint: Point) => Point;
  /** The calibration quad in ground coordinates, used for the extrapolation gate. */
  groundQuad: readonly Point[];
  calibration: Calibration;
  frameWidth: number;
  frameHeight: number;
  timing: TimingSource;
}

export function buildFitContext(calibration: Calibration, frameWidth: number, frameHeight: number,
  timing: TimingSource): FitContext {

  return {
    calibration,
    frameHeight,
    frameWidth,
    // The homography itself is order-independent, but the extrapolation gate treats the quad as a
    // polygon - and a user who clicked the corners in "Z" order would produce a self-intersecting
    // bowtie whose point-in-polygon test is meaningless. Reorder for the gate only.
    groundQuad: orderQuad(calibration.groundPoints),
    timing,
    toGround: createProjector(calibration).toGround
  };
}

/** Sort four points into convex (counter-clockwise) order around their centroid. */
export function orderQuad(quad: readonly Point[]): Point[] {
  if(isConvexQuad(quad)) {
    return [ ...quad ];
  }

  const cx = quad.reduce((a, p) => a + p[0], 0) / quad.length;
  const cy = quad.reduce((a, p) => a + p[1], 0) / quad.length;

  return [ ...quad ].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

/**
 * The point on a bounding box that actually lies on the road plane.
 *
 * The homography maps the ground plane, so the anchor has to be a point on the ground. The bottom
 * centre of the box approximates the contact patch between the tyres and the road; the centroid
 * floats roughly half a vehicle height above it, which projects to a systematically wrong ground
 * position - and the error grows with distance from the camera, so it does not cancel out over a track.
 */
/**
 * Whether a track moved far enough across the image to be worth storing at all.
 *
 * A street view contains parked cars, and the detector finds them in every frame of every event -
 * on a busy road that is tens of megabytes a day of tracks that can only ever be rejected, and a
 * `refit` that has to wade through all of it. This is deliberately a check in *pixels* rather than
 * metres: it must not depend on the calibration, because its whole purpose is to decide what to
 * keep before any calibration is applied, and to stay valid when the calibration later changes.
 *
 * Stop-and-go traffic is safe here: the test is the full range of movement across the track, so a
 * car that waits at a junction and then pulls away still counts as having moved.
 */
export function pixelTravel(track: Track): number {
  if(!track.points.length) {
    return 0;
  }

  const centres = track.points.map((p) => [ (p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2 ]);
  const xs = centres.map((c) => c[0] as number);
  const ys = centres.map((c) => c[1] as number);

  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

export function anchorOf(point: TrackPoint): Point {
  const [ x1, , x2, y2 ] = point.bbox;

  return [ (x1 + x2) / 2, y2 ];
}


interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

/** Ordinary least squares of `y` on `t`, with the coefficient of determination. */
function fitLine(t: readonly number[], y: readonly number[]): LinearFit {
  const n = t.length;
  const meanT = t.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let stt = 0;
  let sty = 0;

  for(let i = 0; i < n; i++) {
    const dt = (t[i] as number) - meanT;

    stt += dt * dt;
    sty += dt * ((y[i] as number) - meanY);
  }

  const slope = stt === 0 ? 0 : sty / stt;
  const intercept = meanY - (slope * meanT);

  let ssRes = 0;
  let ssTot = 0;

  for(let i = 0; i < n; i++) {
    const predicted = intercept + (slope * (t[i] as number));

    ssRes += ((y[i] as number) - predicted) ** 2;
    ssTot += ((y[i] as number) - meanY) ** 2;
  }

  // A perfectly constant axis (a car travelling exactly along the other axis) has zero total
  // variance. That is a perfect fit, not a failed one, so report r2 = 1 rather than dividing by zero.
  return { intercept, r2: ssTot === 0 ? 1 : 1 - (ssRes / ssTot), slope };
}

function rejected(track: Track, reason: string, partial: Partial<SpeedMeasurement> = {}): SpeedMeasurement {
  return {
    cls: track.cls,
    directionDeg: 0,
    distanceM: 0,
    durationS: 0,
    nPoints: track.points.length,
    quality: 0,
    r2: 0,
    rejectedReason: reason,
    speedKph: 0,
    speedMph: 0,
    speedMps: 0,
    trackId: track.trackId,
    ...partial
  };
}

/**
 * Turn one tracked vehicle into a speed measurement, or into a rejection with a reason.
 *
 * Rejections are returned rather than thrown or filtered away: knowing *why* three quarters of a
 * night's tracks were discarded is what tells you whether a threshold needs tuning or the camera
 * needs moving, so the caller persists them alongside the good measurements.
 */
export function measureTrack(track: Track, ctx: FitContext, cfg: Config["speed"]): SpeedMeasurement {
  const scaleX = ctx.calibration.imageWidth / ctx.frameWidth;
  const scaleY = ctx.calibration.imageHeight / ctx.frameHeight;

  if(track.points.length < cfg.minPoints) {
    return rejected(track, "too-few-points");
  }

  const points = [ ...track.points ].sort((a, b) => a.t - b.t);
  const fullDuration = (points[points.length - 1] as TrackPoint).t - (points[0] as TrackPoint).t;

  if(fullDuration < cfg.minDurationS) {
    return rejected(track, "too-brief", { durationS: fullDuration });
  }

  const confidences = points.map((p) => p.conf).sort((a, b) => a - b);
  const medianConf = confidences[Math.floor(confidences.length / 2)] as number;

  if(medianConf < cfg.minMedianConf) {
    return rejected(track, "low-confidence", { durationS: fullDuration });
  }

  // Classify every point as usable or not, but do not reject the track on the first bad one.
  // On a camera where the road spans the frame, every vehicle enters at one edge and leaves at the
  // other, so a track is almost never usable end to end - the measurable pass is the middle of it.
  const drops = new Map<string, number>();
  const drop = (reason: string): null => {
    drops.set(reason, (drops.get(reason) ?? 0) + 1);

    return null;
  };

  const classified = points.map((point): Sample | null => {
    const [ x1, y1, x2, y2 ] = point.bbox;

    // A box clipped by the frame edge has an unstable bottom edge, and the bottom edge is precisely
    // the measurement anchor - so a partially visible vehicle is not measurable.
    if((x1 <= cfg.edgeMarginPx) || (y1 <= cfg.edgeMarginPx) ||
      (x2 >= (ctx.frameWidth - cfg.edgeMarginPx)) || (y2 >= (ctx.frameHeight - cfg.edgeMarginPx))) {

      return drop("touches-frame-edge");
    }

    const anchor = anchorOf(point);
    // Calibration was picked on a snapshot that may differ in resolution from the exported clip.
    const imagePoint: Point = [ anchor[0] * scaleX, anchor[1] * scaleY ];

    // The ROI was drawn on the raw picture, so it is tested in raw pixels - before lens correction,
    // which `toGround` applies internally.
    if(!pointInPolygon(imagePoint, ctx.calibration.roi)) {
      return drop("outside-roi");
    }

    let projected: Point;

    try {
      projected = ctx.toGround(imagePoint);
    } catch {
      return drop("projects-to-horizon");
    }

    // A homography is only trustworthy near the points that defined it. Extrapolated far outside the
    // calibration quad it diverges hard - this is the usual source of absurd readings, so gate on it.
    if(!pointInPolygon(projected, ctx.groundQuad) &&
      (distanceToPolygon(projected, ctx.groundQuad) > cfg.extrapolationMarginM)) {

      return drop("outside-calibrated-area");
    }

    return { ground: projected, t: point.t };
  });

  const run = longestRun(classified);

  if(run.length < cfg.minPoints) {
    // Name the reason that actually cost the most points, so `stats` points at the real problem -
    // a badly placed ROI and a road that is simply too short to see look nothing alike in the fix.
    return rejected(track, dominantReason(drops) ?? "too-few-points",
      { durationS: fullDuration, nPoints: run.length });
  }

  let times = run.map((s) => s.t);
  let ground = run.map((s) => s.ground);
  let fit = fitGround(times, ground);

  // One robustness pass: drop points whose residual is an outlier and refit. A single badly placed
  // box early or late in a track otherwise drags the slope, and the slope is the answer.
  const trimmed = trimOutliers(times, ground, fit, cfg.outlierSigma);

  if((trimmed.times.length >= cfg.minPoints) && (trimmed.times.length < times.length)) {
    times = trimmed.times;
    ground = trimmed.ground;
    fit = fitGround(times, ground);
  }

  const usedDuration = (times[times.length - 1] as number) - (times[0] as number);
  const speedMps = Math.hypot(fit.vx, fit.vy);
  const distanceM = speedMps * usedDuration;

  const base: SpeedMeasurement = {
    cls: track.cls,
    directionDeg: (Math.atan2(fit.vy, fit.vx) * 180) / Math.PI,
    distanceM,
    durationS: usedDuration,
    nPoints: times.length,
    quality: 0,
    r2: fit.r2,
    rejectedReason: null,
    speedKph: speedMps * MPS_TO_KPH,
    speedMph: speedMps * MPS_TO_MPH,
    speedMps,
    trackId: track.trackId
  };

  if(usedDuration < cfg.minDurationS) {
    return { ...base, rejectedReason: "too-brief" };
  }

  if(distanceM < cfg.minDistanceM) {
    return { ...base, rejectedReason: "too-little-travel" };
  }

  // A vehicle that brakes or accelerates through frame is not a constant-velocity sample. Rather
  // than report an average that describes no moment of the pass, discard it.
  if(fit.r2 < cfg.minR2) {
    return { ...base, rejectedReason: "poor-linear-fit" };
  }

  return { ...base, quality: qualityScore(fit.r2, times.length, usedDuration, medianConf, ctx.timing) };
}

interface Sample {
  t: number;
  ground: Point;
}

/**
 * The longest unbroken stretch of usable points.
 *
 * Unbroken matters: a track split by an occlusion could have the vehicle changing lanes or speed
 * behind the obstruction, and stitching the two halves into one fit would silently average across
 * whatever happened in the gap. Measuring the longer half is the honest choice.
 */
function longestRun(classified: readonly (Sample | null)[]): Sample[] {
  let best: Sample[] = [];
  let current: Sample[] = [];

  for(const sample of classified) {
    if(sample) {
      current.push(sample);

      if(current.length > best.length) {
        best = current;
      }
    } else {
      current = [];
    }
  }

  return best;
}

function dominantReason(drops: ReadonlyMap<string, number>): string | null {
  let reason: string | null = null;
  let most = 0;

  for(const [ key, count ] of drops) {
    if(count > most) {
      most = count;
      reason = key;
    }
  }

  return reason;
}

interface GroundFit {
  vx: number;
  vy: number;
  r2: number;
}

/**
 * Fit constant-velocity motion across the ground plane.
 *
 * The velocity components come from independent least-squares fits of X and Y against time, but the
 * goodness-of-fit deliberately does *not*. A vehicle travelling along one ground axis has essentially
 * zero variance in the other, so that axis's r2 would be computed against floating-point noise and
 * come out meaningless. Instead we project the ground track onto its own direction of travel and score
 * distance-along-path against time, which is both numerically stable and the quantity we actually
 * care about: did this vehicle hold a steady speed while it was in view?
 */
function fitGround(times: readonly number[], ground: readonly Point[]): GroundFit {
  const vx = fitLine(times, ground.map((p) => p[0])).slope;
  const vy = fitLine(times, ground.map((p) => p[1])).slope;
  const speed = Math.hypot(vx, vy);

  if(speed === 0) {
    return { r2: 0, vx, vy };
  }

  const ux = vx / speed;
  const uy = vy / speed;
  const alongPath = ground.map((p) => (p[0] * ux) + (p[1] * uy));

  return { r2: fitLine(times, alongPath).r2, vx, vy };
}

function trimOutliers(times: readonly number[], ground: readonly Point[], fit: GroundFit, sigma: number):
  { times: number[]; ground: Point[] } {

  const meanT = times.reduce((a, b) => a + b, 0) / times.length;
  const meanX = ground.reduce((a, p) => a + p[0], 0) / ground.length;
  const meanY = ground.reduce((a, p) => a + p[1], 0) / ground.length;

  const residuals = times.map((t, i) => {
    const p = ground[i] as Point;
    const dx = p[0] - (meanX + (fit.vx * (t - meanT)));
    const dy = p[1] - (meanY + (fit.vy * (t - meanT)));

    return Math.hypot(dx, dy);
  });

  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const sd = Math.sqrt(residuals.reduce((a, r) => a + ((r - mean) ** 2), 0) / residuals.length);
  const limit = Math.max(mean + (sigma * sd), RESIDUAL_FLOOR_M);

  const keptTimes: number[] = [];
  const keptGround: Point[] = [];

  for(let i = 0; i < times.length; i++) {
    if((residuals[i] as number) <= limit) {
      keptTimes.push(times[i] as number);
      keptGround.push(ground[i] as Point);
    }
  }

  return { ground: keptGround, times: keptTimes };
}

/** Composite 0-1 confidence. Deliberately blunt - it ranks measurements, it does not calibrate them. */
function qualityScore(r2: number, nPoints: number, durationS: number, medianConf: number,
  timing: TimingSource): number {

  const fitScore = Math.max(0, Math.min(1, (r2 - 0.9) / 0.1));
  const sampleScore = Math.min(1, nPoints / 25);
  const durationScore = Math.min(1, durationS / 1.5);
  // Nominal timing means the frame clock was assumed rather than read. The speed may still be right,
  // but it is no longer independently verified, so it never scores as highly as a pts-timed track.
  const timingScore = timing === "pts" ? 1 : 0.6;

  return Number(((((fitScore * 0.4) + (sampleScore * 0.2) + (durationScore * 0.2) + (medianConf * 0.2)) *
    timingScore)).toFixed(4));
}
