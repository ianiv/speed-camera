import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCalibration, saveCalibration } from "../calibration.js";
import { CALIBRATION_PATH } from "../config.js";
import type { Calibration } from "../types.js";
import { log } from "../log.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Serve the calibration page for one camera and block until the user saves or interrupts.
 *
 * Bound to loopback only: it serves a live camera snapshot of the user's street, which has no
 * business being reachable from the network.
 */
/**
 * The calibration already on disk, when it belongs to this camera.
 *
 * Reloading it turns recalibration into an edit rather than a redo: adjusting one misplaced point
 * should not cost the lens traces, the ground measurements and the road outline as well. A
 * calibration for a *different* camera is deliberately not offered - its points describe another
 * scene, and silently loading them would invite someone to keep half of them.
 */
function existingFor(cameraId: string): Calibration | null {
  try {
    const existing = loadCalibration();

    if(existing.cameraId !== cameraId) {
      log.info("Ignoring the saved calibration: it belongs to camera " + existing.cameraId + ".");

      return null;
    }

    log.info("Loaded the saved calibration for this camera - it will appear pre-filled.");

    return existing;
  } catch {
    return null;
  }
}

export function runCalibrationServer(cameraId: string, snapshot: Buffer, port: number): Promise<Calibration> {
  // The page sits beside this module in both src and dist; `npm run build` copies it across.
  const html = readFileSync(resolve(HERE, "page.html"), "utf8")
    .replace("window.__CAMERA_ID__", JSON.stringify(cameraId))
    .replace("window.__EXISTING__", JSON.stringify(existingFor(cameraId)));

  return new Promise<Calibration>((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";

      if((req.method === "GET") && ((url === "/") || url.startsWith("/?"))) {
        res.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
        res.end(html);

        return;
      }

      if((req.method === "GET") && (url === "/snapshot.jpg")) {
        res.writeHead(200, { "cache-control": "no-store", "content-type": "image/jpeg" });
        res.end(snapshot);

        return;
      }

      if((req.method === "POST") && (url === "/save")) {
        const chunks: Buffer[] = [];

        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            const calibration = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Calibration;

            saveCalibration(calibration);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: CALIBRATION_PATH }));

            log.info("Saved calibration to " + CALIBRATION_PATH);
            // Give the response time to flush before tearing the server down.
            setTimeout(() => server.close(() => resolvePromise(calibration)), 200);
          } catch(error) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: (error as Error).message }));
          }
        });

        return;
      }

      res.writeHead(404).end("Not found");
    });

    server.on("error", reject);

    server.listen(port, "127.0.0.1", () => {
      log.info("Calibration UI: http://127.0.0.1:" + port + "  (Ctrl-C to abort)");
    });
  });
}
