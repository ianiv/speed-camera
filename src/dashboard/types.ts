/**
 * The dashboard's wire format.
 *
 * Imported by both the server and the browser code, so a change to a response shape breaks the
 * consumer at compile time rather than silently rendering `undefined`. Types only: this file is
 * compiled under two different tsconfigs (Node and DOM) and must not reference either environment.
 */

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

export const RANGES: readonly RangeKey[] = [ "1h", "24h", "7d", "30d", "all" ];

/** One vehicle passing the camera, after duplicate merging. */
export interface Pass {
  eventId: string;
  trackId: number;
  cls: string;
  /** Wall-clock time the vehicle entered the measured stretch, in epoch ms. */
  atMs: number;
  speedKph: number;
  speedMph: number;
  /** Degrees counter-clockwise from ground +X, which runs along the road. */
  directionDeg: number;
  distanceM: number;
  durationS: number;
  r2: number;
  quality: number;
  nPoints: number;
  protectUrl: string;
  /** Raw measurements merged into this pass. 1 means nothing was merged. */
  mergedFrom: number;
}

export interface SpeedStats {
  n: number;
  meanKph: number;
  medianKph: number;
  /**
   * The speed 85% of drivers stay at or below. The standard traffic-engineering statistic, and the
   * one a council or police service asks for - a mean is dragged down by the cautious majority.
   */
  p85Kph: number;
  minKph: number;
  maxKph: number;
  overLimit: number;
  /** `overLimit / n`, in 0-1. */
  overLimitShare: number;
}

export interface HistogramBin {
  fromKph: number;
  toKph: number;
  n: number;
}

export interface HourBucket {
  /** Hour of day, 0-23, in the server's local time. */
  hour: number;
  n: number;
  meanKph: number;
}

export interface DirectionSplit {
  label: string;
  n: number;
  meanKph: number;
  p85Kph: number;
}

/** Passes measured versus events seen - without it the counts read as total traffic, which they are not. */
export interface Coverage {
  events: number;
  rawPasses: number;
  merged: number;
}

export interface Summary {
  range: RangeKey;
  dedupe: boolean;
  generatedAtMs: number;
  speedLimitKph: number;
  binWidthKph: number;
  stats: SpeedStats;
  histogram: HistogramBin[];
  byHour: HourBucket[];
  byDirection: [DirectionSplit, DirectionSplit];
  coverage: Coverage;
}

/**
 * How the passes table is ordered.
 *
 * Applied on the server, not in the browser, because the table fetches only a page of rows: sorting
 * a truncated newest-first page by speed would put the fastest of the recent few at the top and
 * call them the fastest, which is worse than not offering the sort at all.
 */
export type PassSort = "time" | "speed";
export type SortDirection = "asc" | "desc";

export const PASS_SORTS: readonly PassSort[] = [ "time", "speed" ];

export interface PassesResponse {
  range: RangeKey;
  dedupe: boolean;
  speedLimitKph: number;
  directionLabels: [string, string];
  sort: PassSort;
  direction: SortDirection;
  /** Passes matching the range, before the page limit was applied. */
  total: number;
  passes: Pass[];
}
