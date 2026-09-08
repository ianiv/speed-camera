#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createProjector, loadCalibration } from "./calibration.js";
import { runCalibrationServer } from "./calibrate/server.js";
import { PID_NAME, PID_SEARCH, runDashboardServer } from "./dashboard/server.js";
import { livePid, stop } from "./pidfile.js";
import { exportSite } from "./dashboard/publish.js";
import { loadConfig, ROOT } from "./config.js";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { crossCheckSamples, isVehicle, listVehicleEvents, resolveWindow } from "./events.js";
import { pointInPolygon } from "./homography.js";
import { analyzeVideo } from "./worker.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VehicleEvent } from "./events.js";
import { eventUrl } from "./links.js";
import { connect } from "./protect.js";
import type { Protect } from "./protect.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import { buildFitContext, measureTrack } from "./speed.js";
import { downloadClip } from "./clip.js";
import { log } from "./log.js";

const USAGE = `
ufp-speed - estimate vehicle speeds from UniFi Protect motion events

  probe                        Verify credentials, list cameras, test a snapshot and a clip export
  calibrate [--camera <id>]    Pick 4 road points and set the pixels-to-metres mapping
  watch                        Print vehicle events live, without processing them
  daemon                       Process vehicle events as they happen
  backfill --from <t> [--to <t>]
                               Process past events. Times: ISO 8601, or "3h" / "2d" ago
  refit                        Recompute speeds from stored tracks under the current calibration
  crosscheck <eventId>         Sanity-check one event against Protect's own detection boxes
  verify                       Check the calibration against the real size of parked cars
  list [--since <t>] [--min-kph <n>] [--rejected] [--csv]
                               Show measurements
  stats                        Counts and rejection breakdown
  dashboard [--port <n>] [--stop]
                               Serve the speed dashboard on 127.0.0.1, or stop the running one
  publish [--out <dir>] [--deploy] [--every <interval>]
                               Build a public copy of the dashboard, without playback

Options: --debug for verbose logging. Credentials come from .env.
`.trim();

async function main(): Promise<number> {
  const command = process.argv[2];
  const argv = process.argv.slice(3);

  if(!command || [ "-h", "--help", "help" ].includes(command)) {
    process.stdout.write(USAGE + "\n");

    return 0;
  }

  switch(command) {
    case "probe": return probe(argv);
    case "calibrate": return calibrate(argv);
    case "watch": return watch(argv);
    case "daemon": return daemon(argv);
    case "backfill": return backfill(argv);
    case "refit": return refit(argv);
    case "crosscheck": return crosscheck(argv);
    case "verify": return verify(argv);
    case "list": return list(argv);
    case "stats": return stats();
    case "dashboard": return dashboard(argv);
    case "publish": return publish(argv);
    default:
      log.error("Unknown command: " + command + "\n\n" + USAGE);

      return 2;
  }
}

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, w: 604_800_000 };

const RELATIVE = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i;

/** Parse "3h" / "2d" / "45m" as an offset from now, or anything Date understands as absolute. */
function parseTime(value: string): number {
  const relative = RELATIVE.exec(value.trim());

  if(relative) {
    return Date.now() - (Number(relative[1]) * unitMs(relative[2] as string));
  }

  const parsed = Date.parse(value);

  if(Number.isNaN(parsed)) {
    throw new Error('Cannot parse time "' + value + '". Use ISO 8601 (2026-09-01T08:00) or a relative age like 6h.');
  }

  return parsed;
}

function unitMs(suffix: string): number {
  return UNIT_MS[suffix.toLowerCase() as keyof typeof UNIT_MS];
}

/** Parse "15m" / "2h" as a length of time. Same units as `parseTime`, but a duration, not an instant. */
function parseInterval(value: string): number {
  const match = RELATIVE.exec(value.trim());

  if(!match) {
    throw new Error('Cannot parse interval "' + value + '". Use a length like 15m or 2h.');
  }

  return Number(match[1]) * unitMs(match[2] as string);
}

type FlagValues = Record<string, string | boolean | undefined>;

/** `--debug` is accepted by every command, so it lives here rather than in each option list. */
function flags(argv: string[], options: Record<string, { type: "string" } | { type: "boolean" }>): FlagValues {
  return parseArgs({ allowPositionals: false, args: argv,
    options: { debug: { type: "boolean" }, ...options } }).values as FlagValues;
}

/** Pull a single full-resolution frame out of a clip, as JPEG bytes. */
async function extractFrame(videoPath: string): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ufp-speed-frame-"));
  const out = join(dir, "frame.jpg");

  try {
    await new Promise<void>((resolvePromise, reject) => {
      // -q:v 2 keeps the frame close to lossless: this image is what every calibration point is
      // clicked on, so compression artefacts here become measurement error later.
      const child = spawn("ffmpeg", [ "-y", "-loglevel", "error", "-i", videoPath, "-frames:v", "1",
        "-q:v", "2", out ], { stdio: [ "ignore", "ignore", "pipe" ] });
      let stderr = "";

      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (error) => reject(new Error("ffmpeg could not be run: " + error.message)));
      child.on("close", (code) => (code === 0) ? resolvePromise()
        : reject(new Error("ffmpeg failed extracting a frame: " + stderr.slice(-400))));
    });

    const jpeg = readFileSync(out);
    const size = await probeSize(out);

    return { jpeg, ...size };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function probeSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffprobe", [ "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height", "-of", "json", path ], { stdio: [ "ignore", "pipe", "ignore" ] });
    let out = "";

    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const stream = (JSON.parse(out).streams ?? [])[0] as { width: number; height: number };

        resolvePromise({ height: stream.height, width: stream.width });
      } catch(error) {
        reject(new Error("Could not read the extracted frame's dimensions: " + (error as Error).message));
      }
    });
  });
}

/** The value config.example.json ships with, meaning "not chosen yet". */
const PLACEHOLDER_CAMERA = "REPLACE_WITH_CAMERA_ID";

async function probe(argv: string[]): Promise<number> {
  const opts = flags(argv, { camera: { type: "string" } });
  const cfg = safeConfig();

  await using protect = await connect({ debug: Boolean(opts.debug) });

  process.stdout.write("\nCameras:\n");

  for(const camera of protect.client.cameras) {
    const config = camera.config as { name?: string; type?: string; isConnected?: boolean } | undefined;

    process.stdout.write("  " + camera.id + "  " + (config?.name ?? "(unnamed)") +
      "  [" + (config?.type ?? "?") + (config?.isConnected === false ? ", OFFLINE" : "") + "]\n");
  }

  // Prefer the configured camera once it is set - probing a different one than the daemon will use
  // proves nothing about the camera that matters.
  const configured = (cfg.cameraId !== PLACEHOLDER_CAMERA) ? cfg.cameraId : undefined;
  const cameraId = (opts.camera as string | undefined) ?? configured ?? protect.client.cameras[0]?.id;

  if(!cameraId) {
    log.error("No cameras found on this controller.");

    return 1;
  }

  process.stdout.write("\nTesting camera " + cameraId + ":\n");

  const snapshot = await protect.camera(cameraId).snapshot();

  process.stdout.write("  snapshot        OK (" + (snapshot.length / 1024).toFixed(0) + " KB)\n");

  // A short, recent-but-not-live window: the last minute is the most likely to be retained and the
  // least likely to still be being written.
  const end = Date.now() - 60_000;

  try {
    using clip = await downloadClip(protect, cfg, cameraId, end - 10_000, end);

    process.stdout.write("  clip export     OK (" + (clip.bytes / 1e6).toFixed(1) + " MB)\n");
  } catch(error) {
    process.stdout.write("  clip export     FAILED: " + (error as Error).message + "\n");

    return 1;
  }

  const events = await listVehicleEvents(protect, cameraId, Date.now() - 86_400_000, Date.now());

  process.stdout.write("  vehicle events  " + events.length + " in the last 24h\n");

  if(events.length) {
    const first = events[events.length - 1] as VehicleEvent;

    process.stdout.write("  most recent     " + new Date(first.startMs).toLocaleString() + "\n" +
      "  event link      " + eventUrl(cfg.protectUrlTemplate, { cameraId, endMs: first.endMs,
        eventId: first.eventId, host: protect.host, startMs: first.startMs }) + "\n" +
      "\nOpen that link. If it does not land on the event, fix `protectUrlTemplate` in config.json.\n");
  }

  process.stdout.write(configured === cameraId
    ? "\nconfig.json already targets this camera. Next: `calibrate`.\n"
    : "\nSet \"cameraId\": \"" + cameraId + "\" in config.json, then run `calibrate`.\n");

  return 0;
}

/** config.json may not exist yet during `probe`, which is the command that tells you what to put in it. */
function safeConfig(): Config {
  try {
    return loadConfig();
  } catch {
    return loadConfig(resolve(ROOT, "config.example.json"));
  }
}

async function calibrate(argv: string[]): Promise<number> {
  const opts = flags(argv, { camera: { type: "string" }, port: { type: "string" } });
  const cfg = safeConfig();
  const cameraId = (opts.camera as string | undefined) ?? cfg.cameraId;

  await using protect = await connect({ debug: Boolean(opts.debug) });

  // The frame comes from a real clip export, not the snapshot endpoint. The controller serves
  // snapshots at its own reduced size regardless of the dimensions asked for, and calibrating on a
  // 640x360 image would discard most of a 4K camera's precision. Taking a frame from the very
  // stream that gets measured also guarantees the calibration and the measurements share one
  // geometry - same channel, same optics, same encoding.
  log.info("Pulling a clip from " + cameraId + " to calibrate on...");

  const end = Date.now() - 60_000;

  using clip = await downloadClip(protect, cfg, cameraId, end - 6000, end);

  const frame = await extractFrame(clip.path);

  log.info("Calibrating on a " + frame.width + "x" + frame.height + " frame.");

  await runCalibrationServer(cameraId, frame.jpeg, Number((opts.port as string | undefined) ?? 8737));

  return 0;
}

async function watch(argv: string[]): Promise<number> {
  const opts = flags(argv, {});
  const cfg = loadConfig();

  await using protect = await connect({ debug: Boolean(opts.debug) });

  log.info("Watching for vehicle events on " + cfg.cameraId + ". Ctrl-C to stop.");

  for await (const event of protect.client.events({ signal: interruptSignal() })) {
    if(event.kind !== "smartDetect") {
      continue;
    }

    const mine = event.cameraId === cfg.cameraId;

    process.stdout.write(new Date(event.at).toLocaleTimeString() + "  " + event.cameraId +
      (mine ? "" : " (other camera)") + "  [" + event.objectTypes.join(", ") + "]" +
      (isVehicle(event.objectTypes) ? "  <- vehicle" : "") + "\n");
  }

  return 0;
}

async function withPipeline<T>(debug: boolean, fn: (deps: PipelineDeps) => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const calibration = loadCalibration();
  const store = new Store();

  if(calibration.cameraId !== cfg.cameraId) {
    log.warn("Calibration was made for camera " + calibration.cameraId + " but config.json targets " +
      cfg.cameraId + ". Speeds will be wrong unless these match.");
  }

  await using protect = await connect({ debug });

  try {
    return await fn({ calibration, calibrationId: store.calibrationId(calibration), cfg, protect, store });
  } finally {
    store.close();
  }
}

function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return controller.signal;
}

async function daemon(argv: string[]): Promise<number> {
  const opts = flags(argv, {});

  return withPipeline(Boolean(opts.debug), async (deps) => {
    const signal = interruptSignal();

    log.info("Daemon running on camera " + deps.cfg.cameraId + ". Ctrl-C to stop.");

    for await (const event of deps.protect.client.events({ signal })) {
      if((event.kind !== "smartDetect") || (event.cameraId !== deps.cfg.cameraId) ||
        !isVehicle(event.objectTypes)) {

        continue;
      }

      if(deps.store.hasEvent(event.eventId)) {
        continue;
      }

      log.info("Vehicle event " + event.eventId + " at " + new Date(event.at).toLocaleTimeString() +
        "; waiting for it to close...");

      // Each event is handled to completion before the next is picked up. Clip export is the
      // bottleneck and the controller throttles it, so there is nothing to gain from overlapping.
      const window = await resolveWindow(deps.protect, deps.cfg, event.eventId, event.at);

      await processEvent(deps, {
        cameraId: event.cameraId,
        endEstimated: window.endEstimated,
        endMs: window.endMs,
        eventId: event.eventId,
        smartTypes: [ ...event.objectTypes ],
        startMs: event.at
      });
    }

    log.info("Daemon stopped.");

    return 0;
  });
}

async function backfill(argv: string[]): Promise<number> {
  const opts = flags(argv, { force: { type: "boolean" }, from: { type: "string" },
    limit: { type: "string" }, to: { type: "string" } });

  if(!opts.from) {
    log.error("backfill needs --from. Example: --from 6h  or  --from 2026-09-01T08:00");

    return 2;
  }

  const startMs = parseTime(opts.from as string);
  const endMs = opts.to ? parseTime(opts.to as string) : Date.now();

  return withPipeline(Boolean(opts.debug), async (deps) => {
    const all = await listVehicleEvents(deps.protect, deps.cfg.cameraId, startMs, endMs);
    const pending = opts.force ? all : all.filter((e) => !deps.store.hasEvent(e.eventId));
    const events = opts.limit ? pending.slice(0, Number(opts.limit)) : pending;

    log.info(all.length + " vehicle events between " + new Date(startMs).toLocaleString() + " and " +
      new Date(endMs).toLocaleString() + "; " + events.length + " to process.");

    let measured = 0;

    for(const [ i, event ] of events.entries()) {
      log.info("[" + (i + 1) + "/" + events.length + "] " + event.eventId + " " +
        new Date(event.startMs).toLocaleTimeString());

      const outcome = await processEvent(deps, event);

      measured += outcome.measurements.filter((m) => !m.rejectedReason).length;
    }

    log.info("Done. " + measured + " measurement(s) from " + events.length + " event(s).");

    return 0;
  });
}

async function refit(argv: string[]): Promise<number> {
  flags(argv, {});

  const cfg = loadConfig();
  const calibration = loadCalibration();
  const store = new Store();

  try {
    const calibrationId = store.calibrationId(calibration);
    const stored = store.allStoredTracks();
    const byEvent = new Map<string, typeof stored>();

    for(const entry of stored) {
      byEvent.set(entry.eventId, [ ...(byEvent.get(entry.eventId) ?? []), entry ]);
    }

    let measured = 0;

    // Refit is offline by design: no controller, no clips, no model. Recalibrating and seeing the
    // effect on every measurement you already have should take seconds, not a re-download.
    for(const [ eventId, entries ] of byEvent) {
      const measurements = entries.map((entry) => measureTrack(entry.track,
        buildFitContext(calibration, entry.frameWidth, entry.frameHeight, entry.timing), cfg.speed));

      store.saveMeasurements(eventId, calibrationId, measurements);
      measured += measurements.filter((m) => !m.rejectedReason).length;
    }

    if(!stored.length) {
      log.warn("No stored tracks to refit. Run `backfill --from 24h` first.");

      return 0;
    }

    log.info("Refit " + stored.length + " track(s) across " + byEvent.size + " event(s) under " +
      "calibration #" + calibrationId + ": " + measured + " accepted.");

    return 0;
  } finally {
    store.close();
  }
}

/**
 * Check a calibration against something whose real size is already known: a car.
 *
 * Take a snapshot, detect the vehicles in it, and project the ground edge of each bounding box
 * through the homography. A car is about 4.5 m long and 1.8 m wide, so the projected footprint of a
 * parked car says immediately whether the mapping is roughly right - and a scale error found this
 * way is a two-minute fix, where the same error found later looks like every driver on the street
 * going 90 in a 50.
 */
async function verify(argv: string[]): Promise<number> {
  const opts = flags(argv, { camera: { type: "string" } });
  const cfg = loadConfig();
  const calibration = loadCalibration();
  const cameraId = (opts.camera as string | undefined) ?? cfg.cameraId;

  await using protect = await connect({ debug: Boolean(opts.debug) });

  const snapshot = await protect.camera(cameraId).snapshot(
    { height: calibration.imageHeight, width: calibration.imageWidth });

  const dir = mkdtempSync(join(tmpdir(), "ufp-speed-verify-"));
  const file = join(dir, "snapshot.jpg");

  try {
    writeFileSync(file, snapshot);

    const result = await analyzeVideo(cfg, file, { still: true });
    const { toGround } = createProjector(calibration);
    const scaleX = calibration.imageWidth / result.width;
    const scaleY = calibration.imageHeight / result.height;

    process.stdout.write("\nProjected footprint of each vehicle currently in view.\n" +
      "A car seen side-on should read about 4.3-5.0 m; seen head-on, about 1.8-2.0 m.\n\n");

    let checked = 0;

    for(const track of result.tracks) {
      const point = track.points[0];

      if(!point) {
        continue;
      }

      const [ x1, , x2, y2 ] = point.bbox;
      const onRoad = pointInPolygon([ ((x1 + x2) / 2) * scaleX, y2 * scaleY ], calibration.roi);

      let width: number;

      try {
        const left = toGround([ x1 * scaleX, y2 * scaleY ]);
        const right = toGround([ x2 * scaleX, y2 * scaleY ]);

        width = Math.hypot(right[0] - left[0], right[1] - left[1]);
      } catch {
        process.stdout.write("  " + track.cls.padEnd(10) + "  projects to the horizon - outside the calibrated area\n");

        continue;
      }

      const plausible = (width > 1.5) && (width < 6.5);

      process.stdout.write("  " + track.cls.padEnd(10) + width.toFixed(1).padStart(6) + " m  conf=" +
        point.conf.toFixed(2) + (onRoad ? "  in road ROI" : "  outside road ROI (ignored when measuring)") +
        (plausible ? "" : "   <-- implausible for a vehicle") + "\n");

      if(onRoad) {
        checked++;
      }
    }

    if(!result.tracks.length) {
      process.stdout.write("  No vehicles in view. Try again when a car is parked on the street.\n");
    } else if(!checked) {
      process.stdout.write("\nNo detected vehicle sits inside the road ROI, so this says nothing about the\n" +
        "stretch you actually measure. Try again when a car is parked on the street itself.\n");
    }

    process.stdout.write("\nIf a car on the road reads far from ~4.5 m, the calibration distances are wrong.\n" +
      "Fix them with `calibrate`, then `refit` to re-derive every speed you already have.\n\n");

    return 0;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Compare our measurement for one event against a speed derived from the sparse bounding boxes
 * Protect attaches to the event itself.
 *
 * Two or three samples is far too coarse to trust as a measurement. Its value is that it comes from
 * an entirely different detector than ours, through the same homography - so if the two agree to
 * within a rough factor, the pipeline is not inverted, mis-scaled, or pointed at the wrong camera.
 * If they disagree by 10x, something structural is wrong and no amount of threshold tuning will fix it.
 */
async function crosscheck(argv: string[]): Promise<number> {
  const eventId = argv.find((a) => !a.startsWith("--"));

  if(!eventId) {
    log.error("crosscheck needs an event id. Get one from `list`.");

    return 2;
  }

  const opts = flags(argv.filter((a) => a.startsWith("--")), {});
  const calibration = loadCalibration();
  const store = new Store();

  await using protect = await connect({ debug: Boolean(opts.debug) });

  try {
    const samples = await crossCheckSamples(protect, eventId);

    if(samples.length < 2) {
      process.stdout.write("Protect attached " + samples.length + " detection box(es) to this event - " +
        "at least 2 with distinct timestamps are needed to derive anything.\n");

      return 0;
    }

    const { toGround } = createProjector(calibration);
    const first = samples[0] as { tMs: number; coord: number[] };
    const last = samples[samples.length - 1] as { tMs: number; coord: number[] };

    // Protect's coord is [x, y, w, h]; the ground anchor is the bottom centre, as everywhere else.
    const anchor = (c: number[]) => toGround(
      [ (c[0] as number) + ((c[2] as number) / 2), (c[1] as number) + (c[3] as number) ]);

    const a = anchor(first.coord);
    const b = anchor(last.coord);
    const seconds = (last.tMs - first.tMs) / 1000;

    if(seconds <= 0) {
      process.stdout.write("Protect's boxes carry no usable time difference.\n");

      return 0;
    }

    const kph = (Math.hypot(b[0] - a[0], b[1] - a[1]) / seconds) * 3.6;
    const ours = store.measurements({ includeRejected: true, limit: 50 })
      .filter((m) => (m.event_id === eventId) && !m.rejected_reason);

    process.stdout.write("\nProtect boxes    " + samples.length + " samples over " + seconds.toFixed(2) +
      "s  ->  ~" + kph.toFixed(0) + " km/h (very rough)\n");

    if(!ours.length) {
      process.stdout.write("This project     no accepted measurement for this event\n\n");

      return 0;
    }

    for(const m of ours) {
      const ratio = m.speed_kph / kph;

      process.stdout.write("This project     " + m.speed_kph.toFixed(1) + " km/h  (ratio " +
        ratio.toFixed(2) + (((ratio > 0.6) && (ratio < 1.7)) ? ", consistent)" :
          ", INCONSISTENT - check the calibration)") + "\n");
    }

    process.stdout.write("\n");

    return 0;
  } finally {
    store.close();
  }
}

async function list(argv: string[]): Promise<number> {
  const opts = flags(argv, { csv: { type: "boolean" }, limit: { type: "string" },
    "min-kph": { type: "string" }, rejected: { type: "boolean" }, since: { type: "string" } });

  const store = new Store();

  try {
    const rows = store.measurements({
      includeRejected: Boolean(opts.rejected),
      ...(opts.limit ? { limit: Number(opts.limit) } : {}),
      ...(opts["min-kph"] ? { minKph: Number(opts["min-kph"]) } : {}),
      ...(opts.since ? { sinceMs: parseTime(opts.since as string) } : {})
    });

    if(opts.csv) {
      process.stdout.write("time,camera,class,kph,mph,direction_deg,distance_m,duration_s,r2,points,quality,rejected,url\n");

      for(const r of rows) {
        process.stdout.write([ new Date(r.start_ms).toISOString(), r.camera_id, r.cls,
          r.speed_kph.toFixed(1), r.speed_mph.toFixed(1), r.direction_deg.toFixed(1),
          r.distance_m.toFixed(1), r.duration_s.toFixed(2), r.r2.toFixed(3), r.n_points,
          r.quality.toFixed(2), r.rejected_reason ?? "", r.protect_url ].join(",") + "\n");
      }

      return 0;
    }

    if(!rows.length) {
      process.stdout.write("No measurements yet.\n");

      return 0;
    }

    process.stdout.write("\n" + "Time".padEnd(20) + "Class".padEnd(12) + "km/h".padStart(7) +
      "mph".padStart(7) + "  r2".padEnd(8) + "q".padEnd(6) + "Reason".padEnd(24) + "Link\n");
    process.stdout.write("-".repeat(120) + "\n");

    for(const r of rows) {
      process.stdout.write(
        new Date(r.start_ms).toLocaleString().padEnd(20) +
        r.cls.padEnd(12) +
        r.speed_kph.toFixed(1).padStart(7) +
        r.speed_mph.toFixed(1).padStart(7) +
        ("  " + r.r2.toFixed(3)).padEnd(8) +
        r.quality.toFixed(2).padEnd(6) +
        (r.rejected_reason ?? "").padEnd(24) +
        r.protect_url + "\n");
    }

    process.stdout.write("\n" + rows.length + " row(s).\n");

    return 0;
  } finally {
    store.close();
  }
}

async function stats(): Promise<number> {
  const store = new Store();

  try {
    const s = store.stats();

    process.stdout.write("\nEvents seen      " + s.events + "\nTracks stored    " + s.tracks +
      "\nMeasurements     " + s.measured + " accepted, " + s.rejected + " rejected\n");

    const breakdown = store.rejectionBreakdown();

    if(breakdown.length) {
      process.stdout.write("\nWhy tracks were rejected:\n");

      for(const row of breakdown) {
        process.stdout.write("  " + row.reason.padEnd(26) + row.n + "\n");
      }
    }

    process.stdout.write("\n");

    return 0;
  } finally {
    store.close();
  }
}

/**
 * Serve the dashboard until interrupted.
 *
 * Read-only and offline: it reads the database that `daemon` and `backfill` fill, and never touches
 * the controller. So it is safe to leave running beside them.
 */
async function dashboard(argv: string[]): Promise<number> {
  const opts = flags(argv, { port: { type: "string" }, stop: { type: "boolean" } });

  if(opts.stop) {
    return await stopDashboard();
  }

  const cfg = loadConfig();
  const running = livePid(PID_NAME);

  // Without this the only symptom is EADDRINUSE, which says a port is taken but not that the thing
  // taking it is another copy of this command.
  if(running) {
    log.error("The dashboard is already running on port " + running.port + " (pid " + running.pid +
      "). Stop it with `ufp-speed dashboard --stop`.");

    return 1;
  }

  await runDashboardServer(cfg, Number((opts.port as string | undefined) ?? cfg.dashboard.port));

  return 0;
}

/** Stop the running dashboard, and say plainly what was stopped and how it was found. */
async function stopDashboard(): Promise<number> {
  const result = await stop(PID_NAME, PID_SEARCH);

  if(result.outcome === "not-running") {
    log.info("No dashboard is running.");

    return 0;
  }

  const where = result.port === undefined ? "" : " on port " + result.port;
  const how = result.bySearch ? " (found by searching - it was started without a pid file)" : "";

  log.info((result.outcome === "forced"
    ? "Dashboard did not stop in time and was killed"
    : "Stopped the dashboard") + where + " - pid " + result.pids.join(", ") + how + ".");

  return 0;
}

/** Hand the built directory to Wrangler. Everything about where it goes lives in wrangler.jsonc. */
async function deploySite(): Promise<void> {
  const wrangler = resolve(ROOT, "node_modules", ".bin", "wrangler");

  await new Promise<void>((resolveDeploy, reject) => {
    spawn(wrangler, [ "deploy" ], { cwd: ROOT, stdio: "inherit" })
      .on("error", reject)
      .on("close", (code) => code === 0 ? resolveDeploy()
        : reject(new Error("wrangler deploy exited " + code)));
  });
}

/**
 * Build - and optionally upload - a public copy of the dashboard.
 *
 * Read-only against the database, like `dashboard`, so it is safe to run beside the daemon. With
 * `--every` it stays up and repeats, which is how the published page keeps up with the street; a
 * failed upload is logged and retried on the next tick rather than ending the loop, because the
 * usual cause is a laptop that was briefly off the network.
 */
async function publish(argv: string[]): Promise<number> {
  const opts = flags(argv,
    { deploy: { type: "boolean" }, every: { type: "string" }, out: { type: "string" } });

  const cfg = loadConfig();
  const outDir = resolve(ROOT, (opts.out as string | undefined) ?? "public");
  const everyMs = opts.every === undefined ? undefined : parseInterval(opts.every as string);
  const store = new Store();

  try {
    for(;;) {
      try {
        const built = exportSite(store, cfg, outDir);

        log.info("Exported " + built.files + " files, " +
          Math.round(built.bytes / 1024) + " KB, " + built.passes + " passes -> " + built.dir);

        if(opts.deploy) {
          await deploySite();
        }
      } catch(error) {
        if(everyMs === undefined) {
          throw error;
        }

        log.error("Publish failed, will retry: " + (error as Error).message);
      }

      if(everyMs === undefined) {
        return 0;
      }

      await new Promise((sleep) => setTimeout(sleep, everyMs));
    }
  } finally {
    store.close();
  }
}

main().then((code) => process.exit(code), (error) => {
  log.error((error as Error).message);

  if(process.env.LOG_LEVEL === "debug") {
    log.error((error as Error).stack ?? "");
  }

  process.exit(1);
});
