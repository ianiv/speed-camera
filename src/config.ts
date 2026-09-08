import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Project root, resolved relative to this file so the CLI works from any cwd. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG_PATH = resolve(ROOT, "config.json");
export const CALIBRATION_PATH = resolve(ROOT, "data", "calibration.json");
export const DB_PATH = resolve(ROOT, "data", "speeds.db");

const ConfigSchema = z.object({
  cameraId: z.string().min(1),
  protectUrlTemplate: z.string().min(1).default("https://{host}/protect/events/{eventId}"),

  clip: z.object({
    channel: z.number().int().min(0).default(0),
    preRollMs: z.number().int().min(0).default(2000),
    postRollMs: z.number().int().min(0).default(2000),
    maxEventWaitMs: z.number().int().min(0).default(30_000),
    eventPollIntervalMs: z.number().int().min(100).default(1000),
    fallbackDurationMs: z.number().int().min(1000).default(8000),
    downloadTimeoutMs: z.number().int().min(1000).default(60_000)
  }).prefault({}),

  worker: z.object({
    python: z.string().default("py/.venv/bin/python"),
    script: z.string().default("py/worker.py"),
    model: z.string().default("yolo11s.pt"),
    device: z.string().default("mps"),
    conf: z.number().min(0).max(1).default(0.35),
    /** Inference resolution. Raise it if vehicles are small and distant in frame. */
    imgsz: z.number().int().min(320).max(2560).default(960),
    timeoutMs: z.number().int().min(1000).default(300_000)
  }).prefault({}),

  speed: z.object({
    minPoints: z.number().int().min(2).default(8),
    minDurationS: z.number().min(0).default(0.5),
    minDistanceM: z.number().min(0).default(3),
    minR2: z.number().min(0).max(1).default(0.95),
    minMedianConf: z.number().min(0).max(1).default(0.4),
    edgeMarginPx: z.number().min(0).default(4),
    extrapolationMarginM: z.number().min(0).default(5),
    outlierSigma: z.number().min(0.5).default(2.5),
    /**
     * Minimum image-space travel, in pixels, before a track is worth keeping. Parked cars are
     * detected in every frame of every event; storing them would dwarf the real measurements.
     */
    minPixelTravel: z.number().min(0).default(25)
  }).prefault({}),

  /** The posted limit on this street, in km/h. Drives the dashboard's over-limit counts. */
  speedLimitKph: z.number().positive().default(30),

  dashboard: z.object({
    port: z.number().int().min(1).max(65_535).default(8738),
    /**
     * What to call the two directions of travel. The first is the heading along ground +X, which is
     * the axis the calibration quad was measured along. Only the reader knows whether that is
     * "northbound" or "towards the school", so it is a label rather than something derived.
     */
    directionLabels: z.tuple([ z.string(), z.string() ]).default([ "One way", "The other way" ]),
    /**
     * Camera channel for dashboard playback. 0 is the full-resolution stream; on this camera 1 and
     * 2 are a 640x360 substream. Export cost barely differs - a 4K clip comes back in about 250 ms -
     * so 0 is the default and the substream is there for a slow link.
     */
    clipChannel: z.number().int().min(0).max(3).default(0),
    /** Cap on the height of a transcoded clip. Only applies when a browser cannot decode HEVC. */
    clipMaxHeight: z.number().int().min(240).max(2160).default(1080)
  }).prefault({}),

  /** Log a warning when a measured speed exceeds this (km/h). `null` disables. */
  alertKph: z.number().positive().nullable().default(null)
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Credentials {
  host: string;
  username: string;
  password: string;
  verifyTls: boolean;
}

/**
 * Read `.env` without a dependency. Only handles what a credentials file needs:
 * `KEY=value` lines, `#` comments, and optional surrounding quotes.
 */
function loadDotEnv(): void {
  const path = resolve(ROOT, ".env");

  if(!existsSync(path)) {
    return;
  }

  for(const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

    if(!match || line.trimStart().startsWith("#")) {
      continue;
    }

    const [ , key, rawValue ] = match as unknown as [string, string, string];
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");

    // Real environment variables win over the file.
    process.env[key] ??= value;
  }
}

export function loadCredentials(): Credentials {
  loadDotEnv();

  const host = process.env.UFP_HOST;
  const username = process.env.UFP_USERNAME;
  const password = process.env.UFP_PASSWORD;

  const missing = [ [ "UFP_HOST", host ], [ "UFP_USERNAME", username ], [ "UFP_PASSWORD", password ] ]
    .filter(([ , v ]) => !v).map(([ k ]) => k);

  if(missing.length) {
    throw new Error("Missing credentials in .env or the environment: " + missing.join(", ") +
      ". Copy .env.example to .env and fill it in with a local Protect admin account.");
  }

  return {
    host: host as string,
    password: password as string,
    // Protect controllers ship a self-signed cert, so verification is off unless explicitly enabled.
    verifyTls: [ "1", "true", "yes" ].includes((process.env.UFP_VERIFY_TLS ?? "").toLowerCase()),
    username: username as string
  };
}

/** Validate an already-parsed config object and apply defaults. */
export function parseConfig(raw: unknown, source = "config.json"): Config {
  const parsed = ConfigSchema.safeParse(raw);

  if(!parsed.success) {
    throw new Error(source + " is invalid:\n" + z.prettifyError(parsed.error));
  }

  return parsed.data;
}

export function loadConfig(path = CONFIG_PATH): Config {
  if(!existsSync(path)) {
    throw new Error("No config.json at " + path + ". Copy config.example.json to config.json, then run " +
      "`npm run ufp-speed probe` to discover your camera id.");
  }

  return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
}
