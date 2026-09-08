import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "../protect.js";
import type { Protect } from "../protect.js";
import type { Config } from "../config.js";
import { log } from "../log.js";

/** Video codecs the dashboard can serve. */
export type ClipCodec = "hevc" | "h264";

export interface ClipBody {
  bytes: Buffer;
  codec: ClipCodec;
}

/**
 * Cached clips, keyed by event and codec.
 *
 * An export costs about a quarter of a second and a transcode about a second and a half, so this is
 * not about making playback possible - it is about making the second press of play, or a seek that
 * the browser services with a fresh request, feel like a local file.
 */
const cache = new Map<string, ClipBody>();

/** Rough cap on the cache, in bytes. A 4K export is ~5 MB, so this holds a few dozen clips. */
const CACHE_LIMIT_BYTES = 250e6;

function cacheSize(): number {
  let total = 0;

  for(const entry of cache.values()) {
    total += entry.bytes.length;
  }

  return total;
}

/** Evict oldest-first until the cache fits. Map preserves insertion order, so the first key is oldest. */
function evict(): void {
  while((cacheSize() > CACHE_LIMIT_BYTES) && (cache.size > 1)) {
    const oldest = cache.keys().next().value as string;

    cache.delete(oldest);
  }
}

/**
 * Re-encode an HEVC clip as H.264 for browsers that cannot decode HEVC.
 *
 * Hardware-encoded through VideoToolbox, which turns a 13-second 4K clip around in about a second
 * and a half. Downscaled on the way: this is a clip to eyeball a measurement against, not the
 * evidence file, and 4K costs bandwidth and decode effort for detail nobody watching it needs.
 */
function transcode(hevc: Buffer, maxHeight: number): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "ufp-speed-clip-"));
  const input = join(dir, "in.mp4");
  const output = join(dir, "out.mp4");

  writeFileSync(input, hevc);

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", [ "-y", "-loglevel", "error", "-i", input,
      // -2 keeps the width even, which H.264 requires; scale only downwards.
      "-vf", "scale=-2:'min(" + maxHeight + ",ih)'",
      "-c:v", "h264_videotoolbox", "-b:v", "4000k", "-an",
      // Puts the moov atom first so the browser can start playing before the file is complete.
      "-movflags", "+faststart", output ], { stdio: [ "ignore", "ignore", "pipe" ] });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      rmSync(dir, { force: true, recursive: true });
      reject(new Error("ffmpeg could not be run: " + error.message));
    });

    child.on("close", (code) => {
      try {
        if(code !== 0) {
          throw new Error("ffmpeg failed transcoding a clip: " + stderr.slice(-400));
        }

        resolve(readFileSync(output));
      } catch(error) {
        reject(error as Error);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });
  });
}

/**
 * The clip for one event, ready to serve.
 *
 * Protect's export endpoint hands back the whole file in about 250 ms - it is remuxing segments the
 * recorder already has, not re-encoding - so there is nothing to gain from streaming it through.
 * Buffering it here is what lets the dashboard answer range requests, which Protect itself does not
 * support: without that the browser cannot seek, and a scrub bar that does nothing is worse than no
 * scrub bar at all.
 */
export async function clipFor(protect: Protect, cfg: Config, cameraId: string, startMs: number,
  endMs: number, eventId: string, codec: ClipCodec): Promise<ClipBody> {

  const key = eventId + ":" + codec;
  const cached = cache.get(key);

  if(cached) {
    return cached;
  }

  const query = new URLSearchParams({
    camera: cameraId,
    channel: String(cfg.dashboard.clipChannel),
    end: String(Math.round(endMs)),
    start: String(Math.round(startMs))
  });

  const started = Date.now();
  const source = await protect.getBytes(API + "/video/export?" + query.toString(),
    cfg.clip.downloadTimeoutMs);

  if(source.length < 1024) {
    throw new Error("Protect returned no footage for this event. It may have passed out of the " +
      "recorder's retention window.");
  }

  const exported = Date.now() - started;

  // Protect records HEVC, which Safari and Chrome on Apple silicon play directly. Everything else
  // needs H.264, and the page asks for it by name rather than this guessing from a user agent.
  const body: ClipBody = codec === "hevc" ? { bytes: source, codec }
    : { bytes: await transcode(source, cfg.dashboard.clipMaxHeight), codec };

  log.debug("Clip " + eventId + " (" + codec + "): export " + exported + " ms, " +
    (body.bytes.length / 1e6).toFixed(1) + " MB, total " + (Date.now() - started) + " ms");

  cache.set(key, body);
  evict();

  return body;
}

/** Drop everything cached. Only used by tests, which must not leak state between cases. */
export function clearClipCache(): void {
  cache.clear();
}

export type ByteRange = { start: number; end: number } | "whole" | "unsatisfiable";

/**
 * Interpret a `Range` header against a known body size.
 *
 * Its own function because the off-by-one in `Content-Range` is a classic: the header is inclusive
 * at both ends, so a 100-byte reply to `bytes=0-` is `0-99/100`, and getting it wrong gives a video
 * element that stalls partway through a seek with no error anywhere. Worth testing directly rather
 * than by watching a scrub bar.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");

  if(!match || ((match[1] === "") && (match[2] === ""))) {
    return "whole";
  }

  // "bytes=-500" asks for the last 500 bytes; every other form is a start with an optional end.
  const suffix = match[1] === "";
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = (!suffix && (match[2] !== "")) ? Math.min(Number(match[2]), size - 1) : size - 1;

  if((start >= size) || (start > end)) {
    return "unsatisfiable";
  }

  return { end, start };
}
