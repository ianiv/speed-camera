import { ProtectClient } from "unifi-protect";
import type { Camera } from "unifi-protect";
import { loadCredentials } from "./config.js";
import { log } from "./log.js";

export interface Protect extends AsyncDisposable {
  client: ProtectClient;
  host: string;
  /** GET a Protect API path and parse the JSON body. */
  getJson: <T>(path: string, timeoutMs?: number) => Promise<T>;
  /** GET a Protect API path and return the raw bytes (clip exports, images). */
  getBytes: (path: string, timeoutMs?: number) => Promise<Buffer>;
  camera: (id: string) => Camera;
}

/**
 * The Protect API path behind the UniFi OS reverse proxy.
 *
 * Paths are relative; `getJson`/`getBytes` prepend the controller origin, because the transport
 * hands the URL straight to undici and undici requires an absolute one.
 */
export const API = "/proxy/protect/api";

/**
 * Resolve an API path against the controller origin.
 *
 * The transport hands its `url` argument straight to undici, which requires an absolute URL - a
 * bare path fails with `ERR_INVALID_URL`, which the library then reports only as "a network error",
 * making it look like the controller is unreachable when in fact the request was never made.
 */
export function resolveUrl(host: string, path: string): string {
  return path.startsWith("http") ? path : "https://" + host + path;
}

/** Drop the query string, which carries camera ids and timestamps, from user-facing error text. */
function redact(url: string): string {
  return url.split("?")[0] as string;
}

/** Flatten an error's `cause` chain into one line. */
export function describe(error: unknown): string {
  const parts: string[] = [];
  let current = error as { message?: string; code?: string; cause?: unknown } | undefined;

  for(let depth = 0; current && (depth < 6); depth++) {
    const code = current.code ? " [" + current.code + "]" : "";

    if(current.message) {
      parts.push(current.message + code);
    }

    current = current.cause as typeof current;
  }

  return parts.join(" <- ") || String(error);
}

export async function connect(opts: { debug?: boolean } = {}): Promise<Protect> {
  const creds = loadCredentials();

  log.info("Connecting to Protect at " + creds.host + " as " + creds.username + "...");

  const client = await ProtectClient.connect({
    host: creds.host,
    password: creds.password,
    username: creds.username,
    verifyTls: creds.verifyTls,
    ...(opts.debug ? { log: { debug: log.debug, error: log.error, info: log.info, warn: log.warn } } : {})
  });

  log.info("Connected to " + (client.controllerName ?? creds.host) +
    " (" + client.cameras.length + " cameras, admin: " + client.isAdmin + ").");

  // Surface connection loss and recovery. Without this a daemon silently stops seeing events and
  // looks, from the outside, exactly like a quiet street.
  client.connection.on("stateChanged", (t) => log.info("Connection " + t.from + " -> " + t.to +
    (t.reason ? " (" + t.reason + ")" : "")));
  client.connection.on("controllerLost", (e) => log.warn("Controller lost: " + e.message));
  client.connection.on("controllerRecovered", () => log.info("Controller recovered."));

  const send = async (path: string, timeoutMs: number) => {
    const url = resolveUrl(creds.host, path);

    let response;

    try {
      response = await client.transport.send(url, { method: "GET", timeout: timeoutMs });
    } catch(error) {
      // The library's transport errors carry the real fault in `cause` and say only "a network
      // error occurred" at the top. Unwrapping it here is the difference between a diagnosable
      // failure and an afternoon of guessing.
      throw new Error("GET " + redact(url) + " failed: " + describe(error));
    }

    if((response.statusCode < 200) || (response.statusCode >= 300)) {
      throw new Error("GET " + redact(url) + " failed: HTTP " + response.statusCode + " " +
        response.body.subarray(0, 300).toString("utf8"));
    }

    return response;
  };

  return {
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
    },

    camera: (id: string) => {
      const camera = client.camera(id);

      if(!camera) {
        throw new Error("No camera with id " + id + ". Run `ufp-speed probe` to list camera ids.");
      }

      return camera;
    },

    client,
    getBytes: async (path: string, timeoutMs = 30_000) => (await send(path, timeoutMs)).body,
    getJson: async <T>(path: string, timeoutMs = 15_000) => (await send(path, timeoutMs)).json<T>(),
    host: creds.host
  };
}
