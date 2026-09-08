/**
 * Where the page gets its numbers.
 *
 * There are two deployments of this dashboard. The live one runs on the machine holding the
 * database and answers `/api/...` from it; the published one is a directory of JSON snapshots on a
 * CDN, with no database, no controller and no server behind it.
 *
 * This module is the entire difference between them. Every component below it renders whatever it
 * is handed and never learns which it is running in, which is what keeps the published copy from
 * quietly becoming a second, diverging dashboard.
 */

import type { RangeState } from "./range-controls.js";
import type { PassSort, SortDirection } from "../types.js";

export type Mode = "live" | "static";

/** Declared by the page shell: `page.html` says "live", and the exporter rewrites it to "static". */
export const mode: Mode = document.body.dataset.mode === "static" ? "static" : "live";

/** Footage is reachable only from the machine that can talk to the controller. */
export const playback = mode === "live";

/**
 * How often to re-fetch.
 *
 * The live dashboard is watching a database that changes as events arrive. The published one is
 * watching a file that is rewritten on a schedule, so polling it faster than that just burns
 * bandwidth for every visitor at once.
 */
export const pollMs = mode === "live" ? 15_000 : 120_000;

function suffix(state: RangeState): string {
  return state.range + "-" + (state.dedupe ? "1" : "0");
}

export function summaryUrl(state: RangeState): string {
  return mode === "live"
    ? "/api/summary?range=" + state.range + "&dedupe=" + (state.dedupe ? "1" : "0")
    : "api/summary-" + suffix(state) + ".json";
}

/**
 * The passes for a range.
 *
 * The live server sorts and pages, so the ordering is part of the request. A snapshot cannot: it
 * carries every pass in the range and the browser sorts it, so the file is the same whichever
 * column the reader clicked.
 */
export function passesUrl(state: RangeState, sort: PassSort, direction: SortDirection,
  limit: number): string {

  return mode === "live"
    ? "/api/passes?range=" + state.range + "&dedupe=" + (state.dedupe ? "1" : "0") +
      "&limit=" + limit + "&sort=" + sort + "&dir=" + direction
    : "api/passes-" + suffix(state) + ".json";
}
