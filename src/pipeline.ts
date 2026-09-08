import { downloadClip } from "./clip.js";
import { paddedWindow } from "./events.js";
import type { VehicleEvent } from "./events.js";
import { eventUrl } from "./links.js";
import { buildFitContext, measureTrack, pixelTravel } from "./speed.js";
import { analyzeVideo } from "./worker.js";
import type { Config } from "./config.js";
import type { Protect } from "./protect.js";
import type { Store } from "./db.js";
import type { Calibration, SpeedMeasurement } from "./types.js";
import { log } from "./log.js";

export interface PipelineDeps {
  protect: Protect;
  cfg: Config;
  store: Store;
  calibration: Calibration;
  calibrationId: number;
}

export interface EventOutcome {
  eventId: string;
  measurements: SpeedMeasurement[];
  protectUrl: string;
  error?: string;
}

/**
 * Download, track, and measure one vehicle event.
 *
 * Every stage records what it found, including failures - an event that produced no measurable
 * track is still worth knowing about, because a night of nothing but rejections is the signal that
 * the calibration or the thresholds need attention.
 */
export async function processEvent(deps: PipelineDeps, event: VehicleEvent): Promise<EventOutcome> {
  const { calibration, calibrationId, cfg, protect, store } = deps;
  const window = paddedWindow(cfg, event);

  const protectUrl = eventUrl(cfg.protectUrlTemplate, {
    cameraId: event.cameraId,
    endMs: event.endMs,
    eventId: event.eventId,
    host: protect.host,
    startMs: event.startMs
  });

  store.upsertEvent({
    camera_id: event.cameraId,
    end_ms: event.endMs,
    error: null,
    event_id: event.eventId,
    protect_url: protectUrl,
    smart_types: event.smartTypes.join(","),
    start_ms: event.startMs,
    status: "pending"
  });

  try {
    using clip = await downloadClip(protect, cfg, event.cameraId, window.startMs, window.endMs);

    const result = await analyzeVideo(cfg, clip.path);

    // Parked cars are detected in every frame; keeping them would bury the real measurements.
    const moving = result.tracks.filter((track) => pixelTravel(track) >= cfg.speed.minPixelTravel);
    const parked = result.tracks.length - moving.length;

    if(parked) {
      log.debug("Event " + event.eventId + ": ignored " + parked + " stationary vehicle(s).");
    }

    store.saveTracks(event.eventId, moving, result.timing, result.width, result.height);

    if(result.timing === "nominal") {
      log.warn("Event " + event.eventId + ": frame timestamps unavailable, speeds derived from " +
        "nominal frame rate and scored down accordingly.");
    }

    const ctx = buildFitContext(calibration, result.width, result.height, result.timing);
    const measurements = moving.map((track) => measureTrack(track, ctx, cfg.speed));

    store.saveMeasurements(event.eventId, calibrationId, measurements);
    store.setEventStatus(event.eventId, "analyzed");

    const accepted = measurements.filter((m) => !m.rejectedReason);

    for(const m of accepted) {
      const line = "Event " + event.eventId + ": " + m.cls + " at " + m.speedKph.toFixed(1) + " km/h (" +
        m.speedMph.toFixed(1) + " mph), r2=" + m.r2.toFixed(3) + ", " + m.nPoints + " pts, q=" +
        m.quality.toFixed(2);

      if((cfg.alertKph !== null) && (m.speedKph >= cfg.alertKph)) {
        log.warn("SPEEDING " + line + " -> " + protectUrl);
      } else {
        log.info(line);
      }
    }

    if(!accepted.length) {
      log.info("Event " + event.eventId + ": no measurable track (" +
        (measurements.length ? measurements.map((m) => m.rejectedReason).join(", ")
          : (parked ? parked + " stationary vehicle(s) only" : "no vehicles detected")) + ").");
    }

    return { eventId: event.eventId, measurements, protectUrl };
  } catch(error) {
    const message = (error as Error).message;

    log.error("Event " + event.eventId + " failed: " + message);
    store.setEventStatus(event.eventId, "failed", message);

    return { error: message, eventId: event.eventId, measurements: [], protectUrl };
  }
}
