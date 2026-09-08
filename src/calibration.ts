import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CALIBRATION_PATH } from "./config.js";
import { applyHomography, isConvexQuad, solveHomography } from "./homography.js";
import type { Matrix3, Point } from "./homography.js";
import { undistortPoint } from "./lens.js";
import type { Calibration } from "./types.js";

const PointSchema = z.tuple([ z.number(), z.number() ]);

const CalibrationSchema = z.object({
  cameraId: z.string().min(1),
  createdAt: z.string(),
  imageWidth: z.number().positive(),
  imageHeight: z.number().positive(),
  imagePoints: z.tuple([ PointSchema, PointSchema, PointSchema, PointSchema ]),
  groundPoints: z.tuple([ PointSchema, PointSchema, PointSchema, PointSchema ]),
  roi: z.array(PointSchema).min(3),
  lens: z.object({ k1: z.number(), k2: z.number(), cx: z.number(), cy: z.number(), s: z.number().positive() })
    .optional(),
  lensLines: z.array(z.array(PointSchema)).optional(),
  notes: z.string().optional()
});

export function loadCalibration(path = CALIBRATION_PATH): Calibration {
  if(!existsSync(path)) {
    throw new Error("No calibration at " + path + ". Run `ufp-speed calibrate` first - without it " +
      "there is no way to convert pixels into metres.");
  }

  const parsed = CalibrationSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));

  if(!parsed.success) {
    throw new Error("calibration.json is invalid:\n" + z.prettifyError(parsed.error));
  }

  return validate(parsed.data as Calibration);
}

export function saveCalibration(calibration: Calibration, path = CALIBRATION_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validate(calibration), null, 2) + "\n");
}

/**
 * Catch the calibration mistakes that produce plausible-looking but wrong speeds, at the point the
 * calibration is saved rather than a week of measurements later.
 */
export function validate(calibration: Calibration): Calibration {
  if(!isConvexQuad(calibration.imagePoints)) {
    throw new Error("The four image points form a self-intersecting shape. Click them in order " +
      "around the quad (clockwise or counter-clockwise), not diagonally across it.");
  }

  if(!isConvexQuad(calibration.groundPoints)) {
    throw new Error("The four ground points form a self-intersecting shape. Their order must match " +
      "the order the image points were clicked in.");
  }

  // Throws on degenerate input, which is the real check here.
  createProjector(calibration);

  return calibration;
}

/**
 * The one place image pixels become ground metres.
 *
 * Order matters and is easy to get wrong: lens correction first, homography second. The homography
 * is a pinhole model, so it is only meaningful once the lens has been taken out - undistorting
 * afterwards would be correcting the wrong space. Every consumer goes through this, so measurement,
 * `verify` and `crosscheck` cannot drift apart on it.
 */
export function createProjector(calibration: Calibration): {
  toGround: (imagePoint: Point) => Point;
  homography: Matrix3;
} {
  // The clicked points are on the distorted picture, so they need correcting before they can define
  // a pinhole homography.
  const corrected = calibration.imagePoints.map((p) => undistortPoint(calibration.lens, p)) as
    [Point, Point, Point, Point];
  const homography = solveHomography(corrected, calibration.groundPoints);

  return { homography, toGround: (p) => applyHomography(homography, undistortPoint(calibration.lens, p)) };
}

/**
 * Ground coordinates for the common case: four corners of a rectangle measured on the road.
 *
 * Returned in the same corner order the points were clicked - near-left, near-right, far-right,
 * far-left - so `width` is the across-the-street distance (the left-edge-to-right-edge measurement)
 * and `length` is the distance along the road.
 */
export function rectangleGround(width: number, length: number): Calibration["groundPoints"] {
  return [ [ 0, 0 ], [ width, 0 ], [ width, length ], [ 0, length ] ];
}
