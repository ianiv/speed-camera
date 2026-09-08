import type { Point } from "./homography.js";
import type { LensModel } from "./lens.js";

/** One tracked detection in a single video frame, as produced by the Python worker. */
export interface TrackPoint {
  /** Zero-based frame index within the clip. */
  frame: number;
  /** Presentation timestamp in seconds from the start of the clip. */
  t: number;
  /** `[x1, y1, x2, y2]` in pixels. */
  bbox: [number, number, number, number];
  conf: number;
}

export interface Track {
  trackId: number;
  cls: string;
  points: TrackPoint[];
}

/** Whether frame times came from real presentation timestamps or were assumed from nominal fps. */
export type TimingSource = "pts" | "nominal";

export interface WorkerResult {
  video: string;
  fps: number;
  timing: TimingSource;
  width: number;
  height: number;
  tracks: Track[];
}

export interface Calibration {
  cameraId: string;
  createdAt: string;
  /** Image dimensions the points were picked on. Track coordinates are rescaled if the clip differs. */
  imageWidth: number;
  imageHeight: number;
  /** The four picked image points, in pixels. */
  imagePoints: [Point, Point, Point, Point];
  /** The corresponding real-world ground coordinates, in metres. */
  groundPoints: [Point, Point, Point, Point];
  /** Road polygon in image pixels. Anchors outside it are rejected. */
  roi: Point[];
  /**
   * Radial lens correction, solved from traced real-world-straight lines. Absent means the camera
   * is treated as rectilinear - fine for a narrow lens, wrong for a wide one.
   */
  lens?: LensModel;
  /** The lines that were traced to solve `lens`, kept so the solve can be reviewed or redone. */
  lensLines?: Point[][];
  notes?: string;
}

export interface SpeedMeasurement {
  trackId: number;
  cls: string;
  speedMps: number;
  speedKph: number;
  speedMph: number;
  /** Direction of travel on the ground plane, degrees counter-clockwise from +X. */
  directionDeg: number;
  distanceM: number;
  durationS: number;
  r2: number;
  nPoints: number;
  /** 0-1 composite of fit quality, sample count, and timing source. */
  quality: number;
  /** `null` when the measurement passed every gate. */
  rejectedReason: string | null;
}
