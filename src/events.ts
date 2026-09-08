import { API } from "./protect.js";
import type { Protect } from "./protect.js";
import type { Config } from "./config.js";
import { log } from "./log.js";

/** A vehicle event with a resolved time window, ready to be turned into a clip. */
export interface VehicleEvent {
  eventId: string;
  cameraId: string;
  startMs: number;
  endMs: number;
  smartTypes: string[];
  /** True when `endMs` was assumed rather than reported by the controller. */
  endEstimated: boolean;
}

/** The subset of Protect's event payload this project reads. */
interface ProtectEvent {
  id: string;
  camera?: string;
  start: number;
  end: number | null;
  type: string;
  smartDetectTypes?: string[];
  metadata?: { detectedThumbnails?: { coord?: number[]; clockBestWall?: number }[] };
}

export function isVehicle(types: readonly string[] | undefined): boolean {
  return (types ?? []).includes("vehicle");
}

/**
 * Wait for an in-progress event to close, then return its window.
 *
 * A smart-detect packet arrives when the event *starts*, so at that moment the recording we want
 * does not exist yet. Polling the event until the controller stamps an `end` is what makes the
 * exported clip contain the whole pass rather than its first frame.
 */
export async function resolveWindow(protect: Protect, cfg: Config, eventId: string,
  startMs: number): Promise<{ endMs: number; endEstimated: boolean }> {

  const deadline = Date.now() + cfg.clip.maxEventWaitMs;

  while(Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.clip.eventPollIntervalMs));

    try {
      const event = await protect.getJson<ProtectEvent>(API + "/events/" + encodeURIComponent(eventId));

      if(event.end) {
        return { endEstimated: false, endMs: event.end };
      }
    } catch(error) {
      log.debug("Event poll failed for " + eventId + ": " + (error as Error).message);
    }
  }

  // A vehicle that parks in frame keeps its event open indefinitely. Rather than block the pipeline,
  // take a fixed window - the pass itself happened at the start of it either way.
  log.warn("Event " + eventId + " did not close within " + cfg.clip.maxEventWaitMs + " ms; " +
    "using a " + cfg.clip.fallbackDurationMs + " ms window.");

  return { endEstimated: true, endMs: startMs + cfg.clip.fallbackDurationMs };
}

/** Historical vehicle events for a time range, oldest first. */
export async function listVehicleEvents(protect: Protect, cameraId: string,
  startMs: number, endMs: number): Promise<VehicleEvent[]> {

  const query = new URLSearchParams({
    cameras: cameraId,
    end: String(Math.round(endMs)),
    start: String(Math.round(startMs)),
    types: "smartDetectZone"
  });

  const events = await protect.getJson<ProtectEvent[]>(API + "/events?" + query.toString(), 60_000);

  return events
    .filter((e) => isVehicle(e.smartDetectTypes) && e.end)
    .map((e) => ({
      cameraId: e.camera ?? cameraId,
      endEstimated: false,
      endMs: e.end as number,
      eventId: e.id,
      smartTypes: e.smartDetectTypes ?? [],
      startMs: e.start
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Apply the configured padding to an event's window.
 *
 * Takes only the two timestamps rather than a whole `VehicleEvent`, so the dashboard can ask for
 * the same window from a stored row. The padding has to match what was measured: a clip served for
 * playback that started somewhere else would not show the frames the speed came from.
 */
export function paddedWindow(cfg: Config, event: { startMs: number; endMs: number }):
  { startMs: number; endMs: number } {
  return { endMs: event.endMs + cfg.clip.postRollMs, startMs: event.startMs - cfg.clip.preRollMs };
}

/**
 * An independent, very rough speed from the sparse bounding boxes Protect itself attaches to the
 * event. Two or three samples is far too few to trust, but it is derived from a completely separate
 * source than our tracker - so agreement within an order of magnitude confirms the pipeline is not
 * inverted, mis-scaled, or reading the wrong camera.
 */
export async function crossCheckSamples(protect: Protect, eventId: string):
  Promise<{ tMs: number; coord: number[] }[]> {

  try {
    const event = await protect.getJson<ProtectEvent>(API + "/events/" + encodeURIComponent(eventId));

    return (event.metadata?.detectedThumbnails ?? [])
      .filter((t): t is { coord: number[]; clockBestWall: number } =>
        Array.isArray(t.coord) && (t.coord.length === 4) && (typeof t.clockBestWall === "number"))
      .map((t) => ({ coord: t.coord, tMs: t.clockBestWall }))
      .sort((a, b) => a.tMs - b.tMs);
  } catch {
    return [];
  }
}
