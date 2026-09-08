import "./range-controls.js";
import "./stat-tiles.js";
import "./speed-histogram.js";
import "./time-of-day-chart.js";
import "./passes-table.js";

import type { RangeControls, RangeState } from "./range-controls.js";
import type { PassesData, SortChange } from "./passes-table.js";
import type { HistogramData } from "./speed-histogram.js";
import type { TilesData } from "./stat-tiles.js";
import type { TimeOfDayData } from "./time-of-day-chart.js";
import type { PassesResponse, PassSort, SortDirection, Summary } from "../types.js";

/** How often to re-fetch. Events arrive at walking pace, so anything faster is just noise. */
const POLL_MS = 15_000;

/** Rows fetched for the table. Beyond this the browser, not the data, becomes the bottleneck. */
const TABLE_LIMIT = 500;

interface Panels {
  tiles: { data: TilesData };
  histogram: { data: HistogramData };
  timeOfDay: { data: TimeOfDayData };
  passes: { data: PassesData };
}

function panel<K extends keyof Panels>(selector: string): Panels[K] {
  const element = document.querySelector(selector);

  if(!element) {
    throw new Error("The page is missing " + selector);
  }

  return element as unknown as Panels[K];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });

  if(!response.ok) {
    throw new Error(path + " returned " + response.status);
  }

  return await response.json() as T;
}

let state: RangeState = { dedupe: true, range: "24h" };
let sort: { sort: PassSort; direction: SortDirection } = { direction: "desc", sort: "time" };
let lastLoadedMs = 0;
let inFlight = false;

function setFreshness(text: string): void {
  const element = document.querySelector("#freshness");

  if(element) {
    element.textContent = text;
  }
}

function renderCoverage(summary: Summary): void {
  const element = document.querySelector("#coverage");

  if(!element) {
    return;
  }

  const { coverage, stats } = summary;
  const merged = coverage.merged
    ? " " + coverage.merged + " duplicate reading" + (coverage.merged === 1 ? "" : "s") +
      " from overlapping events were merged."
    : "";

  // Without this line the counts read as total traffic, which they are not: a pass is only counted
  // when the fit passed every quality gate, so the true volume on the street is higher.
  element.innerHTML = stats.n + " measured pass" + (stats.n === 1 ? "" : "es") + " from " +
    coverage.events + " vehicle event" + (coverage.events === 1 ? "" : "s") + "." + merged +
    " Events whose tracks failed a quality gate are not counted here - run <code>ufp-speed stats</code>" +
    " for the rejection breakdown.";
}

async function load(): Promise<void> {
  if(inFlight) {
    return;
  }

  inFlight = true;

  const query = "range=" + state.range + "&dedupe=" + (state.dedupe ? "1" : "0");

  try {
    const [ summary, passes ] = await Promise.all([
      getJson<Summary>("/api/summary?" + query),
      getJson<PassesResponse>("/api/passes?" + query + "&limit=" + TABLE_LIMIT +
        "&sort=" + sort.sort + "&dir=" + sort.direction)
    ]);

    panel<"tiles">("stat-tiles").data =
      { speedLimitKph: summary.speedLimitKph, stats: summary.stats };

    panel<"histogram">("speed-histogram").data = {
      histogram: summary.histogram,
      speedLimitKph: summary.speedLimitKph,
      stats: summary.stats
    };

    panel<"timeOfDay">("time-of-day-chart").data = {
      byDirection: summary.byDirection,
      byHour: summary.byHour,
      speedLimitKph: summary.speedLimitKph
    };

    panel<"passes">("passes-table").data = {
      direction: passes.direction,
      directionLabels: passes.directionLabels,
      passes: passes.passes,
      sort: passes.sort,
      speedLimitKph: passes.speedLimitKph,
      total: passes.total
    };

    renderCoverage(summary);

    lastLoadedMs = Date.now();
    setFreshness("updated just now");
  } catch(error) {
    // A failed poll is usually the server being restarted, so say so and keep polling rather than
    // wiping a page of good data.
    setFreshness("could not reach the server - " + (error as Error).message);
  } finally {
    inFlight = false;
  }
}

function tickFreshness(): void {
  if(!lastLoadedMs) {
    return;
  }

  const seconds = Math.round((Date.now() - lastLoadedMs) / 1000);

  setFreshness(seconds < 5 ? "updated just now"
    : seconds < 90 ? "updated " + seconds + "s ago"
      : "updated " + Math.round(seconds / 60) + " min ago");
}

const controls = document.querySelector("range-controls") as RangeControls | null;

controls?.addEventListener("range-change", (event) => {
  state = (event as CustomEvent<RangeState>).detail;
  void load();
});

// Re-sorting goes back to the server: it holds every pass in range, and the table only ever has a
// page of them.
document.querySelector("passes-table")?.addEventListener("sort-change", (event) => {
  sort = (event as CustomEvent<SortChange>).detail;
  void load();
});

setInterval(tickFreshness, 1000);
setInterval(() => void load(), POLL_MS);

// Pick the data back up promptly after the laptop has been shut, rather than waiting out the poll.
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible") {
    void load();
  }
});

void load();
