import { describe, expect, it } from "vitest";
import { applyHomography, invertHomography, solveHomography } from "../src/homography.js";
import type { Point } from "../src/homography.js";
import { buildFitContext, measureTrack, pixelTravel } from "../src/speed.js";
import type { Calibration, Track, TrackPoint } from "../src/types.js";
import { loadConfigDefaults } from "./helpers.js";

const FRAME_W = 1920;
const FRAME_H = 1080;

/** A perspective view looking obliquely down a street - the case a single scale factor gets wrong. */
const CALIBRATION: Calibration = {
  cameraId: "test",
  createdAt: new Date(0).toISOString(),
  groundPoints: [ [ 0, 0 ], [ 30, 0 ], [ 30, 8 ], [ 0, 8 ] ],
  imageHeight: FRAME_H,
  imagePoints: [ [ 180, 980 ], [ 1180, 470 ], [ 1810, 520 ], [ 320, 1060 ] ],
  imageWidth: FRAME_W,
  roi: [ [ 0, 300 ], [ 1920, 300 ], [ 1920, 1080 ], [ 0, 1080 ] ]
};

const CFG = loadConfigDefaults().speed;

/**
 * Build a synthetic track by driving a point along the ground at a constant speed and projecting it
 * back into the image, so the test exercises the real inverse-perspective path end to end.
 */
function syntheticTrack(speedMps: number, opts: {
  fps?: number; frames?: number; y?: number; x0?: number; jitterPx?: number; boxPx?: number;
} = {}): Track {
  const { boxPx = 90, fps = 15, frames = 20, jitterPx = 0, x0 = 2, y = 4 } = opts;
  const inverse = invertHomography(solveHomography(CALIBRATION.imagePoints, CALIBRATION.groundPoints));
  const points: TrackPoint[] = [];

  for(let i = 0; i < frames; i++) {
    const t = i / fps;
    const [ px, py ] = applyHomography(inverse, [ x0 + (speedMps * t), y ] as Point);
    // Deterministic jitter, so a failure is reproducible rather than flaky.
    const jitter = jitterPx * Math.sin(i * 2.399963);

    points.push({
      bbox: [ px - (boxPx / 2), py - boxPx + jitter, px + (boxPx / 2), py + jitter ],
      conf: 0.9,
      frame: i,
      t
    });
  }

  return { cls: "car", points, trackId: 1 };
}

function measure(track: Track, timing: "pts" | "nominal" = "pts") {
  return measureTrack(track, buildFitContext(CALIBRATION, FRAME_W, FRAME_H, timing), CFG);
}

describe("measureTrack", () => {
  it("recovers a known speed through a perspective view", () => {
    for(const kph of [ 20, 30, 50, 80 ]) {
      const result = measure(syntheticTrack(kph / 3.6));

      expect(result.rejectedReason).toBeNull();
      expect(result.speedKph).toBeCloseTo(kph, 6);
      expect(result.r2).toBeGreaterThan(0.999);
    }
  });

  it("is not fooled by perspective, unlike a single uniform scale", () => {
    // Same physical speed, near lane and far lane. A uniform pixels-per-metre scale would report
    // these as very different; the homography must report them as the same.
    const near = measure(syntheticTrack(50 / 3.6, { y: 1.5 }));
    const far = measure(syntheticTrack(50 / 3.6, { y: 6.5 }));

    expect(near.rejectedReason).toBeNull();
    expect(far.rejectedReason).toBeNull();
    expect(near.speedKph).toBeCloseTo(50, 6);
    expect(far.speedKph).toBeCloseTo(50, 6);
  });

  it("reports direction of travel, with opposite directions 180 degrees apart", () => {
    const forward = measure(syntheticTrack(40 / 3.6));
    const reverse = measure(syntheticTrack(-40 / 3.6, { x0: 26 }));

    expect(reverse.rejectedReason).toBeNull();
    expect(Math.abs(Math.abs(forward.directionDeg - reverse.directionDeg) - 180)).toBeLessThan(1);
    expect(reverse.speedKph).toBeCloseTo(40, 6);
  });

  it("stays close under realistic bounding-box jitter", () => {
    const result = measure(syntheticTrack(50 / 3.6, { jitterPx: 6 }));

    expect(result.rejectedReason).toBeNull();
    expect(result.speedKph).toBeGreaterThan(45);
    expect(result.speedKph).toBeLessThan(55);
  });

  it("scales track coordinates when the clip resolution differs from the calibration snapshot", () => {
    const track = syntheticTrack(50 / 3.6);
    const halved: Track = { ...track, points: track.points.map((p) => ({ ...p,
      bbox: p.bbox.map((v) => v / 2) as [number, number, number, number] })) };
    const ctx = buildFitContext(CALIBRATION, FRAME_W / 2, FRAME_H / 2, "pts");

    expect(measureTrack(halved, ctx, CFG).speedKph).toBeCloseTo(50, 6);
  });
});

describe("quality gates", () => {
  it("rejects a track with too few points", () => {
    const track = syntheticTrack(50 / 3.6, { frames: 5 });

    expect(measure(track).rejectedReason).toBe("too-few-points");
  });

  it("rejects a track that is too brief", () => {
    const track = syntheticTrack(50 / 3.6, { fps: 60, frames: 12 });

    expect(measure(track).rejectedReason).toBe("too-brief");
  });

  it("rejects a low-confidence track", () => {
    const track = syntheticTrack(50 / 3.6);

    expect(measure({ ...track, points: track.points.map((p) => ({ ...p, conf: 0.2 })) }).rejectedReason)
      .toBe("low-confidence");
  });

  it("rejects a track that is clipped by the frame throughout", () => {
    const track = syntheticTrack(50 / 3.6);
    const clipped: Track = { ...track, points: track.points.map((p) =>
      ({ ...p, bbox: [ 0, p.bbox[1], p.bbox[2], p.bbox[3] ] as [number, number, number, number] })) };

    expect(measure(clipped).rejectedReason).toBe("touches-frame-edge");
  });

  it("rejects a nearly stationary vehicle for lack of travel", () => {
    expect(measure(syntheticTrack(0.3)).rejectedReason).toBe("too-little-travel");
  });

  it("rejects a braking vehicle rather than reporting a meaningless average", () => {
    const inverse = invertHomography(solveHomography(CALIBRATION.imagePoints, CALIBRATION.groundPoints));
    const points: TrackPoint[] = [];

    // Decelerating from ~72 km/h to a stop: the average is real but describes no moment of the pass.
    for(let i = 0; i < 20; i++) {
      const t = i / 15;
      const x = 2 + (20 * t) - (0.5 * 15 * t * t);
      const [ px, py ] = applyHomography(inverse, [ x, 4 ] as Point);

      points.push({ bbox: [ px - 45, py - 90, px + 45, py ], conf: 0.9, frame: i, t });
    }

    expect(measure({ cls: "car", points, trackId: 1 }).rejectedReason).toBe("poor-linear-fit");
  });

  it("rejects a track projecting outside the calibrated area, by the configured margin", () => {
    // A lane 2m beyond the calibrated quad's far edge. Still comfortably in frame and in the ROI, so
    // only the extrapolation margin decides - which is the point: it is the margin doing the work.
    const track = syntheticTrack(50 / 3.6, { y: 10 });
    const ctx = buildFitContext(CALIBRATION, FRAME_W, FRAME_H, "pts");

    expect(measureTrack(track, ctx, { ...CFG, extrapolationMarginM: 5 }).rejectedReason).toBeNull();
    expect(measureTrack(track, ctx, { ...CFG, extrapolationMarginM: 0.5 }).rejectedReason)
      .toBe("outside-calibrated-area");
  });

  it("measures the usable middle of a track that enters and leaves at the frame edges", () => {
    // The normal case on a camera where the road spans the frame: the vehicle is clipped as it
    // enters and again as it leaves. Rejecting the whole pass for that would discard nearly
    // every car on such a view, so the measurable middle is what gets fitted.
    const track = syntheticTrack(50 / 3.6, { frames: 26 });
    const edged: Track = { ...track, points: track.points.map((p, i) => ((i < 4) || (i > 21)
      ? { ...p, bbox: [ 0, p.bbox[1], p.bbox[2], p.bbox[3] ] as [number, number, number, number] } : p)) };
    const result = measure(edged);

    expect(result.rejectedReason).toBeNull();
    expect(result.speedKph).toBeCloseTo(50, 6);
    expect(result.nPoints).toBe(18);
  });

  it("takes the longer side of a track broken in the middle, rather than fitting across the gap", () => {
    // An occlusion splits the track. The vehicle could have changed speed behind the obstruction,
    // so the two halves must not be stitched into one fit.
    const track = syntheticTrack(50 / 3.6, { frames: 30 });
    const split: Track = { ...track, points: track.points.map((p, i) => ((i >= 8) && (i <= 10)
      ? { ...p, bbox: [ 0, p.bbox[1], p.bbox[2], p.bbox[3] ] as [number, number, number, number] } : p)) };
    const result = measure(split);

    expect(result.rejectedReason).toBeNull();
    expect(result.nPoints).toBe(19);
    expect(result.speedKph).toBeCloseTo(50, 6);
  });

  it("blames the gate that actually cost the most points", () => {
    const narrow: Calibration = { ...CALIBRATION, roi: [ [ 0, 0 ], [ 50, 0 ], [ 50, 50 ], [ 0, 50 ] ] };
    const ctx = buildFitContext(narrow, FRAME_W, FRAME_H, "pts");

    expect(measureTrack(syntheticTrack(50 / 3.6), ctx, CFG).rejectedReason).toBe("outside-roi");
  });

  it("scores nominal timing below pts timing for an identical track", () => {
    const track = syntheticTrack(50 / 3.6);

    expect(measure(track, "nominal").quality).toBeLessThan(measure(track, "pts").quality);
  });
});

describe("pixelTravel", () => {
  it("is near zero for a parked car jittering in place", () => {
    const track = syntheticTrack(50 / 3.6);
    const parked: Track = { ...track, points: track.points.map((p, i) => ({ ...p,
      bbox: [ 900 + (i % 3), 400 + (i % 2), 1100 + (i % 3), 560 + (i % 2) ] as [number, number, number, number] })) };

    expect(pixelTravel(parked)).toBeLessThan(25);
  });

  it("is large for a vehicle crossing the frame", () => {
    expect(pixelTravel(syntheticTrack(50 / 3.6))).toBeGreaterThan(200);
  });

  it("counts a car that waits and then pulls away", () => {
    // Stop-and-go must not read as parked: the test is the full range of movement, not the
    // step between consecutive frames.
    const track = syntheticTrack(50 / 3.6);
    const stopThenGo: Track = { ...track, points: track.points.map((p, i) => ({ ...p,
      bbox: (i < 12 ? [ 900, 400, 1100, 560 ] : [ 1500, 400, 1700, 560 ]) as [number, number, number, number] })) };

    expect(pixelTravel(stopThenGo)).toBeGreaterThan(500);
  });

  it("is zero for an empty track", () => {
    expect(pixelTravel({ cls: "car", points: [], trackId: 1 })).toBe(0);
  });
});
