import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { byDirection, byHourOfDay, BIN_WIDTH_KPH, histogram, sortPasses, speedStats } from "./aggregate.js";
import { clipFor, parseByteRange } from "./clips.js";
import type { ClipCodec } from "./clips.js";
import { connect } from "../protect.js";
import type { Protect } from "../protect.js";
import { paddedWindow } from "../events.js";
import { dedupePasses } from "../dedupe.js";
import type { CandidatePass } from "../dedupe.js";
import { ROOT } from "../config.js";
import type { Config } from "../config.js";
import { Store } from "../db.js";
import { claim } from "../pidfile.js";
import type { PassRow } from "../db.js";
import { PASS_SORTS, RANGES } from "./types.js";
import type { PassesResponse, PassSort, RangeKey, SortDirection, Summary } from "./types.js";
import { log } from "../log.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The browser bundle: sources in, compiled tree out.
 *
 * `dist/web` is its own root rather than a corner of `dist/dashboard`, because the Node build writes
 * there too - and both configs compile `types.ts` and `aggregate.ts`. Sharing a directory means two
 * compilers racing to write the same file. Keeping them apart also makes this tree exactly what gets
 * published, so a URL that works locally works on the public site.
 */
const UI_SRC = resolve(ROOT, "src", "dashboard", "ui");
export const UI_OUT = resolve(ROOT, "dist", "web");

const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "1h": 3_600_000,
  "7d": 604_800_000,
  "24h": 86_400_000,
  "30d": 2_592_000_000
};

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

/** Newest mtime under a directory tree, or 0 when it does not exist. */
function newestMtime(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .reduce((newest, entry) =>
        Math.max(newest, statSync(resolve(entry.parentPath, entry.name)).mtimeMs), 0);
  } catch {
    return 0;
  }
}

/**
 * Compile the browser code if it is missing or older than its source.
 *
 * The CLI is normally run through `tsx`, which compiles the Node side on the fly but knows nothing
 * about the browser modules - so without this, `dashboard` would work only after a separate
 * `npm run build` and would otherwise serve a stale page with no hint as to why. A compile failure
 * aborts startup rather than falling back to the previous build, because a dashboard quietly
 * showing yesterday's code is worse than one that refuses to start.
 */
export function ensureUiBuilt(): void {
  if(newestMtime(UI_OUT) > newestMtime(UI_SRC)) {
    return;
  }

  log.info("Compiling the dashboard UI...");

  const result = spawnSync(resolve(ROOT, "node_modules", ".bin", "tsc"),
    [ "-p", resolve(ROOT, "tsconfig.ui.json") ], { encoding: "utf8" });

  if(result.status !== 0) {
    throw new Error("Could not compile the dashboard UI:\n" +
      ((result.stdout ?? "") + (result.stderr ?? "")).trim());
  }

  // tsc only emits JavaScript, so the stylesheet has to come across separately. Copying it into the
  // same directory keeps the server with a single, simple asset root.
  mkdirSync(resolve(UI_OUT, "ui"), { recursive: true });
  copyFileSync(resolve(UI_SRC, "style.css"), resolve(UI_OUT, "ui", "style.css"));
}

function rangeStart(range: RangeKey): number | undefined {
  return range === "all" ? undefined : Date.now() - RANGE_MS[range];
}

/**
 * Place each measurement on the wall clock.
 *
 * A track's frame times are relative to the start of the exported clip, and the clip starts
 * `preRollMs` before the event - so this is where a measurement stops being "2.3 seconds into some
 * video" and becomes an instant that can be compared against a measurement from a different clip.
 */
function toCandidates(rows: readonly PassRow[], preRollMs: number): CandidatePass[] {
  return rows.map((row) => {
    const clipStartMs = row.start_ms - preRollMs;

    return {
      atMs: clipStartMs + (row.first_t * 1000),
      cls: row.cls,
      directionDeg: row.direction_deg,
      distanceM: row.distance_m,
      durationS: row.duration_s,
      endMs: clipStartMs + (row.last_t * 1000),
      eventId: row.event_id,
      mergedFrom: 1,
      nPoints: row.n_points,
      protectUrl: row.protect_url,
      quality: row.quality,
      r2: row.r2,
      speedKph: row.speed_kph,
      speedMph: row.speed_mph,
      trackId: row.track_id
    };
  });
}

function parseRange(value: string | null): RangeKey {
  return RANGES.includes(value as RangeKey) ? value as RangeKey : "24h";
}

/** One range's passes, plus the counts the coverage line needs. */
export interface Collected {
  passes: ReturnType<typeof dedupePasses>;
  rawCount: number;
  events: number;
}

export function collectPasses(store: Store, cfg: Config, range: RangeKey, dedupe: boolean):
  Collected {

  const sinceMs = rangeStart(range);
  const rows = store.passRows(sinceMs === undefined ? {} : { sinceMs });
  const candidates = toCandidates(rows, cfg.clip.preRollMs);

  const passes = dedupe ? dedupePasses(candidates)
    : candidates.map(({ endMs: _endMs, ...pass }) => pass).sort((a, b) => b.atMs - a.atMs);

  return { events: store.eventCount(sinceMs), passes, rawCount: candidates.length };
}

/**
 * The `/api/summary` payload, from an already-collected range.
 *
 * It takes the collection rather than doing it, so a caller that needs both payloads for one range -
 * the static exporter does - reads SQLite and dedupes once instead of twice.
 */
export function buildSummary(cfg: Config, range: RangeKey, dedupe: boolean,
  collected: Collected): Summary {

  const { events, passes, rawCount } = collected;

  return {
    binWidthKph: BIN_WIDTH_KPH,
    byDirection: byDirection(passes, cfg.dashboard.directionLabels),
    byHour: byHourOfDay(passes),
    coverage: { events, merged: rawCount - passes.length, rawPasses: rawCount },
    dedupe,
    generatedAtMs: Date.now(),
    histogram: histogram(passes, cfg.speedLimitKph),
    range,
    speedLimitKph: cfg.speedLimitKph,
    stats: speedStats(passes, cfg.speedLimitKph)
  };
}

/** The `/api/passes` payload. `playback` tells the table whether footage is reachable from here. */
export function buildPasses(cfg: Config, range: RangeKey, dedupe: boolean, collected: Collected,
  sort: PassSort, direction: SortDirection, limit: number, playback: boolean): PassesResponse {

  return {
    dedupe,
    direction,
    directionLabels: cfg.dashboard.directionLabels,
    passes: sortPasses(collected.passes, sort, direction).slice(0, Math.max(1, limit)),
    playback,
    range,
    sort,
    speedLimitKph: cfg.speedLimitKph,
    total: collected.passes.length
  };
}

/**
 * Serve one clip, honouring range requests.
 *
 * Protect's own export endpoint answers every request with the whole file and ignores `Range`, so a
 * browser talking to it directly cannot seek. Buffering the export and doing the ranging here is
 * what turns it into something a `<video>` element can scrub.
 */
async function serveClip(deps: ClipDeps, res: ServerResponse, req: IncomingMessage,
  eventId: string, codec: ClipCodec): Promise<void> {

  const event = deps.store.event(eventId);

  if(!event) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No event " + eventId }));

    return;
  }

  const protect = await deps.protect();
  const window = paddedWindow(deps.cfg, { endMs: event.end_ms, startMs: event.start_ms });

  const { bytes } = await clipFor(protect, deps.cfg, event.camera_id, window.startMs, window.endMs,
    eventId, codec);

  const type = "video/mp4" + (codec === "hevc" ? "; codecs=\"hvc1\"" : "");
  const range = parseByteRange(req.headers.range, bytes.length);

  if(range === "unsatisfiable") {
    res.writeHead(416, { "content-range": "bytes */" + bytes.length }).end();

    return;
  }

  if(range === "whole") {
    res.writeHead(200, { "accept-ranges": "bytes", "cache-control": "no-store",
      "content-length": String(bytes.length), "content-type": type });
    res.end(bytes);

    return;
  }

  res.writeHead(206, {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(range.end - range.start + 1),
    "content-range": "bytes " + range.start + "-" + range.end + "/" + bytes.length,
    "content-type": type
  });
  res.end(bytes.subarray(range.start, range.end + 1));
}

interface ClipDeps {
  cfg: Config;
  store: Store;
  protect: () => Promise<Protect>;
}

/** The name this server records itself under, so `dashboard --stop` can find it again. */
export const PID_NAME = "dashboard";

/**
 * Matches this project's dashboard however it was started - `tsx src/cli.ts` or `node dist/cli.js`.
 *
 * Only used when there is no pid file to go on, so it is anchored on the entry point rather than on
 * the word "dashboard", which would match far too much on a developer's machine.
 */
export const PID_SEARCH = "cli\\.(ts|js) dashboard";

/**
 * Serve the dashboard until interrupted.
 *
 * Bound to loopback only, like the calibration server: this is a log of the traffic outside the
 * user's home, tied to timestamps and clickable back into their camera system.
 */
export function runDashboardServer(cfg: Config, port: number): Promise<void> {
  ensureUiBuilt();

  const store = new Store();

  // Connected on the first press of play, not at startup. Everything except playback reads only the
  // local database, and a controller that is down or unreachable should not stop you looking at the
  // measurements you already have.
  let connecting: Promise<Protect> | undefined;

  const protect = () => (connecting ??= connect({}).catch((error) => {
    connecting = undefined;

    throw error;
  }));

  const clipDeps: ClipDeps = { cfg, protect, store };
  // The page ships as a static shell; everything it renders arrives over the API.
  const page = readFileSync(resolve(HERE, "page.html"), "utf8");

  return new Promise<void>((_resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      const json = (body: unknown): void => {
        res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      try {
        if((path === "/") || (path === "/index.html")) {
          res.writeHead(200, { "cache-control": "no-store", "content-type": MIME[".html"] as string });
          res.end(page);

          return;
        }

        if(path === "/api/summary") {
          const range = parseRange(url.searchParams.get("range"));
          const dedupe = url.searchParams.get("dedupe") !== "0";

          json(buildSummary(cfg, range, dedupe, collectPasses(store, cfg, range, dedupe)));

          return;
        }

        if(path === "/api/passes") {
          const range = parseRange(url.searchParams.get("range"));
          const dedupe = url.searchParams.get("dedupe") !== "0";
          const limit = Number(url.searchParams.get("limit") ?? 500);
          const sortParam = url.searchParams.get("sort");
          const sort: PassSort = PASS_SORTS.includes(sortParam as PassSort)
            ? sortParam as PassSort : "time";
          const direction: SortDirection = url.searchParams.get("dir") === "asc" ? "asc" : "desc";

          json(buildPasses(cfg, range, dedupe, collectPasses(store, cfg, range, dedupe),
            sort, direction, limit, true));

          return;
        }

        const clip = /^\/api\/clip\/([A-Za-z0-9-]{1,64})$/.exec(path);

        if(clip) {
          const codec: ClipCodec = url.searchParams.get("codec") === "h264" ? "h264" : "hevc";

          serveClip(clipDeps, res, req, clip[1] as string, codec).catch((error: Error) => {
            log.error("Clip " + clip[1] + " failed: " + error.message);

            if(!res.headersSent) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: error.message }));
            }
          });

          return;
        }

        // Static UI assets, served at the same paths the published site uses so the two cannot
        // drift. `resolve` collapses any ".." before the guard below sees it, so a traversal ends up
        // outside UI_OUT and is refused rather than followed.
        const asset = resolve(UI_OUT, path.replace(/^\/+/, ""));
        const type = MIME[extname(asset)];

        if(type && asset.startsWith(UI_OUT + sep) && existsSync(asset)) {
          res.writeHead(200, { "cache-control": "no-store", "content-type": type });
          res.end(readFileSync(asset));

          return;
        }

        res.writeHead(404).end("Not found");
      } catch(error) {
        log.error("Request " + path + " failed: " + (error as Error).message);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
    });

    let release: (() => void) | undefined;

    server.on("error", (error) => {
      release?.();
      store.close();
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      // Claimed only once the port is actually bound. Writing it before would leave a pid file
      // describing a process that is about to exit because the port was taken.
      release = claim(PID_NAME, port, () => {
        log.info("Stopping the dashboard.");
        server.close();
        store.close();
        process.exit(0);
      });

      log.info("Dashboard: http://127.0.0.1:" + port +
        "  (Ctrl-C, or `ufp-speed dashboard --stop`)");
    });
  });
}
