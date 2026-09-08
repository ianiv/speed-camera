import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.js";
import type { Calibration, SpeedMeasurement, TimingSource, Track } from "./types.js";

export type EventStatus = "pending" | "analyzed" | "failed" | "skipped";

export interface EventRow {
  event_id: string;
  camera_id: string;
  start_ms: number;
  end_ms: number;
  smart_types: string;
  protect_url: string;
  ingested_at: string;
  status: EventStatus;
  error: string | null;
}

export interface MeasurementRow extends EventRow {
  id: number;
  track_id: number;
  cls: string;
  speed_kph: number;
  speed_mph: number;
  speed_mps: number;
  direction_deg: number;
  distance_m: number;
  duration_s: number;
  r2: number;
  n_points: number;
  quality: number;
  rejected_reason: string | null;
  created_at: string;
}

/** An accepted measurement plus the track timing needed to place it on the wall clock. */
export interface PassRow {
  event_id: string;
  track_id: number;
  cls: string;
  speed_kph: number;
  speed_mph: number;
  direction_deg: number;
  distance_m: number;
  duration_s: number;
  r2: number;
  n_points: number;
  quality: number;
  start_ms: number;
  protect_url: string;
  /** Seconds from the start of the clip to the track's first and last frame. */
  first_t: number;
  last_t: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  camera_id   TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  smart_types TEXT NOT NULL,
  protect_url TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS calibrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json       TEXT NOT NULL
);

-- Raw tracks are kept so 'refit' can re-derive speeds under a new calibration without
-- re-downloading a clip or re-running the model. They are the expensive part to reproduce.
CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL,
  cls         TEXT NOT NULL,
  n_points    INTEGER NOT NULL,
  timing      TEXT NOT NULL,
  frame_width  INTEGER NOT NULL,
  frame_height INTEGER NOT NULL,
  points_json TEXT NOT NULL,
  UNIQUE(event_id, track_id)
);

CREATE TABLE IF NOT EXISTS measurements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  track_id        INTEGER NOT NULL,
  calibration_id  INTEGER NOT NULL,
  cls             TEXT NOT NULL,
  speed_mps       REAL NOT NULL,
  speed_kph       REAL NOT NULL,
  speed_mph       REAL NOT NULL,
  direction_deg   REAL NOT NULL,
  distance_m      REAL NOT NULL,
  duration_s      REAL NOT NULL,
  r2              REAL NOT NULL,
  n_points        INTEGER NOT NULL,
  quality         REAL NOT NULL,
  rejected_reason TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE(event_id, track_id, calibration_id)
);

CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ms);
CREATE INDEX IF NOT EXISTS idx_measurements_event ON measurements(event_id);
CREATE INDEX IF NOT EXISTS idx_measurements_speed ON measurements(speed_kph);
`;

export class Store {
  readonly db: Database.Database;

  constructor(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  hasEvent(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId) !== undefined;
  }

  upsertEvent(row: Omit<EventRow, "ingested_at"> & { ingested_at?: string }): void {
    this.db.prepare(`
      INSERT INTO events (event_id, camera_id, start_ms, end_ms, smart_types, protect_url, ingested_at, status, error)
      VALUES (@event_id, @camera_id, @start_ms, @end_ms, @smart_types, @protect_url, @ingested_at, @status, @error)
      ON CONFLICT(event_id) DO UPDATE SET
        end_ms = excluded.end_ms, status = excluded.status, error = excluded.error
    `).run({ ...row, error: row.error ?? null, ingested_at: row.ingested_at ?? new Date().toISOString() });
  }

  setEventStatus(eventId: string, status: EventStatus, error: string | null = null): void {
    this.db.prepare("UPDATE events SET status = ?, error = ? WHERE event_id = ?").run(status, error, eventId);
  }

  saveTracks(eventId: string, tracks: readonly Track[], timing: TimingSource,
    frameWidth: number, frameHeight: number): void {

    const insert = this.db.prepare(`
      INSERT INTO tracks (event_id, track_id, cls, n_points, timing, frame_width, frame_height, points_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, track_id) DO UPDATE SET
        cls = excluded.cls, n_points = excluded.n_points, timing = excluded.timing,
        frame_width = excluded.frame_width, frame_height = excluded.frame_height,
        points_json = excluded.points_json
    `);

    this.db.transaction(() => {
      for(const track of tracks) {
        insert.run(eventId, track.trackId, track.cls, track.points.length, timing,
          frameWidth, frameHeight, JSON.stringify(track.points));
      }
    })();
  }

  /** Every stored track, for `refit`. */
  allStoredTracks(): { eventId: string; timing: TimingSource; frameWidth: number; frameHeight: number; track: Track }[] {
    const rows = this.db.prepare(`
      SELECT event_id, track_id, cls, timing, frame_width, frame_height, points_json FROM tracks ORDER BY event_id
    `).all() as { event_id: string; track_id: number; cls: string; timing: TimingSource;
      frame_width: number; frame_height: number; points_json: string }[];

    return rows.map((r) => ({
      eventId: r.event_id,
      frameHeight: r.frame_height,
      frameWidth: r.frame_width,
      timing: r.timing,
      track: { cls: r.cls, points: JSON.parse(r.points_json), trackId: r.track_id }
    }));
  }

  saveMeasurements(eventId: string, calibrationId: number, measurements: readonly SpeedMeasurement[]): void {
    const insert = this.db.prepare(`
      INSERT INTO measurements (event_id, track_id, calibration_id, cls, speed_mps, speed_kph, speed_mph,
        direction_deg, distance_m, duration_s, r2, n_points, quality, rejected_reason, created_at)
      VALUES (@event_id, @track_id, @calibration_id, @cls, @speed_mps, @speed_kph, @speed_mph,
        @direction_deg, @distance_m, @duration_s, @r2, @n_points, @quality, @rejected_reason, @created_at)
      ON CONFLICT(event_id, track_id, calibration_id) DO UPDATE SET
        speed_mps = excluded.speed_mps, speed_kph = excluded.speed_kph, speed_mph = excluded.speed_mph,
        direction_deg = excluded.direction_deg, distance_m = excluded.distance_m,
        duration_s = excluded.duration_s, r2 = excluded.r2, n_points = excluded.n_points,
        quality = excluded.quality, rejected_reason = excluded.rejected_reason, created_at = excluded.created_at
    `);

    this.db.transaction(() => {
      for(const m of measurements) {
        insert.run({
          calibration_id: calibrationId,
          cls: m.cls,
          created_at: new Date().toISOString(),
          direction_deg: m.directionDeg,
          distance_m: m.distanceM,
          duration_s: m.durationS,
          event_id: eventId,
          n_points: m.nPoints,
          quality: m.quality,
          r2: m.r2,
          rejected_reason: m.rejectedReason,
          speed_kph: m.speedKph,
          speed_mph: m.speedMph,
          speed_mps: m.speedMps,
          track_id: m.trackId
        });
      }
    })();
  }

  saveCalibration(calibration: Calibration): number {
    const info = this.db.prepare("INSERT INTO calibrations (camera_id, created_at, json) VALUES (?, ?, ?)")
      .run(calibration.cameraId, calibration.createdAt, JSON.stringify(calibration));

    return Number(info.lastInsertRowid);
  }

  /**
   * The row id of the stored calibration matching this one, inserting it if it is new.
   * Measurements carry it so a recalibration produces a comparable second opinion rather than
   * silently overwriting the first.
   */
  calibrationId(calibration: Calibration): number {
    const json = JSON.stringify(calibration);
    const existing = this.db.prepare("SELECT id FROM calibrations WHERE json = ?").get(json) as
      { id: number } | undefined;

    return existing?.id ?? this.saveCalibration(calibration);
  }

  measurements(opts: { sinceMs?: number; minKph?: number; includeRejected?: boolean; limit?: number } = {}):
    MeasurementRow[] {

    const where: string[] = [];
    const params: (number | string)[] = [];

    if(opts.sinceMs !== undefined) {
      where.push("e.start_ms >= ?");
      params.push(opts.sinceMs);
    }

    if(opts.minKph !== undefined) {
      where.push("m.speed_kph >= ?");
      params.push(opts.minKph);
    }

    if(!opts.includeRejected) {
      where.push("m.rejected_reason IS NULL");
    }

    const sql = "SELECT m.*, e.camera_id, e.start_ms, e.end_ms, e.smart_types, e.protect_url, e.ingested_at, " +
      "e.status, e.error FROM measurements m JOIN events e ON e.event_id = m.event_id" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY e.start_ms DESC LIMIT ?";

    params.push(opts.limit ?? 500);

    return this.db.prepare(sql).all(...params) as MeasurementRow[];
  }

  /**
   * Accepted measurements joined to the track that produced them, for the dashboard.
   *
   * The extra columns over `measurements()` are the track's first and last frame times. Combined
   * with the event's start they place each measurement on the wall clock, which is what lets
   * duplicate passes from overlapping Protect events be recognised as the same vehicle. See
   * `dedupePasses`.
   *
   * Separate from `measurements()` rather than an option on it because that method's 500-row
   * default would silently truncate a 30-day view into a plausible-looking lie.
   */
  passRows(opts: { sinceMs?: number; limit?: number } = {}): PassRow[] {
    const sql = `
      SELECT m.event_id, m.track_id, m.cls, m.speed_kph, m.speed_mph, m.direction_deg,
             m.distance_m, m.duration_s, m.r2, m.n_points, m.quality,
             e.start_ms, e.protect_url, t.points_json
      FROM measurements m
      JOIN events e ON e.event_id = m.event_id
      JOIN tracks t ON t.event_id = m.event_id AND t.track_id = m.track_id
      WHERE m.rejected_reason IS NULL` +
      (opts.sinceMs === undefined ? "" : " AND e.start_ms >= @since") +
      " ORDER BY e.start_ms DESC LIMIT @limit";

    const rows = this.db.prepare(sql).all({
      limit: opts.limit ?? 50_000,
      since: opts.sinceMs ?? 0
    }) as (Omit<PassRow, "first_t" | "last_t"> & { points_json: string })[];

    return rows.map(({ points_json, ...row }) => {
      const points = JSON.parse(points_json) as { t: number }[];

      return {
        ...row,
        first_t: points[0]?.t ?? 0,
        last_t: points[points.length - 1]?.t ?? 0
      };
    });
  }

  /** One event by id, for serving its footage. */
  event(eventId: string): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as
      EventRow | undefined;
  }

  /** Events seen in a window, so the dashboard can say how many produced a measurement. */
  eventCount(sinceMs?: number): number {
    const sql = "SELECT COUNT(*) n FROM events" + (sinceMs === undefined ? "" : " WHERE start_ms >= ?");

    return (this.db.prepare(sql).get(...(sinceMs === undefined ? [] : [ sinceMs ])) as { n: number }).n;
  }

  stats(): { events: number; tracks: number; measured: number; rejected: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;

    return {
      events: one("SELECT COUNT(*) n FROM events"),
      measured: one("SELECT COUNT(*) n FROM measurements WHERE rejected_reason IS NULL"),
      rejected: one("SELECT COUNT(*) n FROM measurements WHERE rejected_reason IS NOT NULL"),
      tracks: one("SELECT COUNT(*) n FROM tracks")
    };
  }

  /** Rejection reasons by frequency - the first thing to look at when coverage is low. */
  rejectionBreakdown(): { reason: string; n: number }[] {
    return this.db.prepare(`
      SELECT rejected_reason AS reason, COUNT(*) AS n FROM measurements
      WHERE rejected_reason IS NOT NULL GROUP BY rejected_reason ORDER BY n DESC
    `).all() as { reason: string; n: number }[];
  }
}
