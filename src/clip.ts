import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "./protect.js";
import type { Protect } from "./protect.js";
import type { Config } from "./config.js";
import { log } from "./log.js";

/**
 * Protect's export endpoint is a server-side operation on the NVR, and the controller throttles
 * concurrent requests. Serialising downloads keeps a burst of events (a queue of cars at a light)
 * from making every one of them fail.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);

  queue = result.catch(() => undefined);

  return result;
}

export interface Clip extends Disposable {
  path: string;
  bytes: number;
}

/**
 * Download the exported MP4 for a time range and write it to a temp file.
 *
 * The caller disposes the returned clip (`using clip = await downloadClip(...)`), which removes the
 * temp directory - clips are large and there is no reason to keep them once tracks are extracted.
 */
export async function downloadClip(protect: Protect, cfg: Config, cameraId: string,
  startMs: number, endMs: number): Promise<Clip> {

  const query = new URLSearchParams({
    camera: cameraId,
    channel: String(cfg.clip.channel),
    end: String(Math.round(endMs)),
    start: String(Math.round(startMs))
  });

  const path = API + "/video/export?" + query.toString();

  const body = await serialize(async () => {
    try {
      return await protect.getBytes(path, cfg.clip.downloadTimeoutMs);
    } catch(error) {
      // One retry: an export can fail transiently while the NVR is busy writing the very recording
      // we just asked it for.
      log.warn("Clip download failed, retrying once: " + (error as Error).message);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      return protect.getBytes(path, cfg.clip.downloadTimeoutMs);
    }
  });

  if(body.length < 1024) {
    throw new Error("Export returned " + body.length + " bytes - not a usable clip. The requested range " +
      "may predate the camera's retention window.");
  }

  const dir = mkdtempSync(join(tmpdir(), "ufp-speed-"));
  const file = join(dir, "clip.mp4");

  writeFileSync(file, body);
  log.debug("Downloaded " + (body.length / 1e6).toFixed(1) + " MB clip to " + file);

  return {
    [Symbol.dispose]: () => rmSync(dir, { force: true, recursive: true }),
    bytes: body.length,
    path: file
  };
}
