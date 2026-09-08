import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { buildFitContext, measureTrack } from "../src/speed.js";
import { applyHomography, invertHomography, solveHomography } from "../src/homography.js";
import type { Point } from "../src/homography.js";
import type { Calibration, Track, TrackPoint } from "../src/types.js";
import { loadConfigDefaults } from "./helpers.js";

const CFG = loadConfigDefaults();

const CALIBRATION: Calibration = {
  cameraId: "cam1",
  createdAt: new Date(0).toISOString(),
  groundPoints: [ [ 0, 0 ], [ 30, 0 ], [ 30, 8 ], [ 0, 8 ] ],
  imageHeight: 1080,
  imagePoints: [ [ 180, 980 ], [ 1180, 470 ], [ 1810, 520 ], [ 320, 1060 ] ],
  imageWidth: 1920,
  roi: [ [ 0, 300 ], [ 1920, 300 ], [ 1920, 1080 ], [ 0, 1080 ] ]
};

function trackAt(speedMps: number): Track {
  const inverse = invertHomography(solveHomography(CALIBRATION.imagePoints, CALIBRATION.groundPoints));
  const points: TrackPoint[] = [];

  for(let i = 0; i < 20; i++) {
    const t = i / 15;
    const [ px, py ] = applyHomography(inverse, [ 2 + (speedMps * t), 4 ] as Point);

    points.push({ bbox: [ px - 45, py - 90, px + 45, py ], conf: 0.9, frame: i, t });
  }

  return { cls: "car", points, trackId: 7 };
}

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ufp-speed-test-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  function seedEvent(eventId = "evt1"): void {
    store.upsertEvent({ camera_id: "cam1", end_ms: 1000, error: null, event_id: eventId,
      protect_url: "https://nvr/protect/events/" + eventId, smart_types: "vehicle",
      start_ms: 0, status: "pending" });
  }

  it("round-trips an event and reports it as seen", () => {
    expect(store.hasEvent("evt1")).toBe(false);
    seedEvent();
    expect(store.hasEvent("evt1")).toBe(true);
  });

  it("round-trips tracks with their frame geometry intact", () => {
    seedEvent();

    const track = trackAt(50 / 3.6);

    store.saveTracks("evt1", [ track ], "pts", 1920, 1080);

    const stored = store.allStoredTracks();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.frameWidth).toBe(1920);
    expect(stored[0]?.timing).toBe("pts");
    expect(stored[0]?.track.points).toHaveLength(track.points.length);
    expect(stored[0]?.track.points[0]?.bbox).toEqual(track.points[0]?.bbox);
  });

  it("re-measures stored tracks without the original clip, which is what refit does", () => {
    seedEvent();
    store.saveTracks("evt1", [ trackAt(50 / 3.6) ], "pts", 1920, 1080);

    const entry = store.allStoredTracks()[0];
    const ctx = buildFitContext(CALIBRATION, entry!.frameWidth, entry!.frameHeight, entry!.timing);
    const measurement = measureTrack(entry!.track, ctx, CFG.speed);

    expect(measurement.rejectedReason).toBeNull();
    expect(measurement.speedKph).toBeCloseTo(50, 6);
  });

  it("keeps measurements from different calibrations side by side", () => {
    seedEvent();

    const track = trackAt(50 / 3.6);

    store.saveTracks("evt1", [ track ], "pts", 1920, 1080);

    // A second calibration that says the road is twice as wide should read twice the speed - and
    // must not overwrite the first result, so the two can be compared.
    const doubled: Calibration = { ...CALIBRATION, groundPoints: [ [ 0, 0 ], [ 60, 0 ], [ 60, 16 ], [ 0, 16 ] ] };

    for(const calibration of [ CALIBRATION, doubled ]) {
      const id = store.calibrationId(calibration);
      const ctx = buildFitContext(calibration, 1920, 1080, "pts");

      store.saveMeasurements("evt1", id, [ measureTrack(track, ctx, CFG.speed) ]);
    }

    const rows = store.measurements({ includeRejected: true });

    expect(rows).toHaveLength(2);

    const speeds = rows.map((r) => Math.round(r.speed_kph)).sort((a, b) => a - b);

    expect(speeds[0]).toBe(50);
    expect(speeds[1]).toBe(100);
  });

  it("reuses a calibration id rather than inserting a duplicate", () => {
    expect(store.calibrationId(CALIBRATION)).toBe(store.calibrationId({ ...CALIBRATION }));
  });

  it("hides rejected measurements unless asked, and counts why", () => {
    seedEvent();

    const id = store.calibrationId(CALIBRATION);
    const good = measureTrack(trackAt(50 / 3.6), buildFitContext(CALIBRATION, 1920, 1080, "pts"), CFG.speed);
    const bad = { ...good, rejectedReason: "poor-linear-fit", trackId: 8 };

    store.saveMeasurements("evt1", id, [ good, bad ]);

    expect(store.measurements()).toHaveLength(1);
    expect(store.measurements({ includeRejected: true })).toHaveLength(2);
    expect(store.rejectionBreakdown()).toEqual([ { n: 1, reason: "poor-linear-fit" } ]);
    expect(store.stats()).toMatchObject({ events: 1, measured: 1, rejected: 1 });
  });

  it("filters by speed", () => {
    seedEvent();

    const id = store.calibrationId(CALIBRATION);
    const ctx = buildFitContext(CALIBRATION, 1920, 1080, "pts");

    store.saveMeasurements("evt1", id, [
      { ...measureTrack(trackAt(30 / 3.6), ctx, CFG.speed), trackId: 1 },
      { ...measureTrack(trackAt(70 / 3.6), ctx, CFG.speed), trackId: 2 }
    ]);

    expect(store.measurements({ minKph: 50 })).toHaveLength(1);
    expect(store.measurements({ minKph: 50 })[0]?.speed_kph).toBeCloseTo(70, 3);
  });
});
