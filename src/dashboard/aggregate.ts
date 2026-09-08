import type { DirectionSplit, HistogramBin, HourBucket, Pass, PassSort, SortDirection, SpeedStats }
  from "./types.js";

/** Histogram bin width in km/h. Two is fine enough to show a shape without turning into noise. */
export const BIN_WIDTH_KPH = 2;

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

/**
 * Percentile by linear interpolation between the two nearest ranks.
 *
 * Interpolating rather than picking the nearest sample matters at these sample sizes: with 46
 * passes the 85th percentile falls between two of them, and rounding to one or the other moves the
 * headline figure by a full km/h.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if(!sorted.length) {
    return 0;
  }

  const rank = (sorted.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] as number;

  return low === high ? lowValue : lowValue + ((sorted[high] as number) - lowValue) * (rank - low);
}

export function speedStats(passes: readonly Pass[], speedLimitKph: number): SpeedStats {
  const speeds = passes.map((p) => p.speedKph).sort((a, b) => a - b);
  const overLimit = speeds.filter((kph) => kph > speedLimitKph).length;

  return {
    maxKph: speeds.length ? speeds[speeds.length - 1] as number : 0,
    meanKph: mean(speeds),
    medianKph: percentile(speeds, 0.5),
    minKph: speeds.length ? speeds[0] as number : 0,
    n: speeds.length,
    overLimit,
    overLimitShare: speeds.length ? overLimit / speeds.length : 0,
    p85Kph: percentile(speeds, 0.85)
  };
}

/**
 * Speed histogram, always starting at zero and always covering the speed limit.
 *
 * Anchoring the axis rather than fitting it to the data keeps the shape comparable between range
 * selections - a quiet hour and a busy week should put the same speed in the same place - and
 * guarantees the limit line has somewhere to sit even on a day when nobody reached it.
 */
export function histogram(passes: readonly Pass[], speedLimitKph: number): HistogramBin[] {
  const fastest = passes.reduce((max, p) => Math.max(max, p.speedKph), speedLimitKph * 1.2);
  const bins: HistogramBin[] = [];

  for(let from = 0; from < fastest; from += BIN_WIDTH_KPH) {
    bins.push({ fromKph: from, n: 0, toKph: from + BIN_WIDTH_KPH });
  }

  for(const pass of passes) {
    const index = Math.min(Math.floor(pass.speedKph / BIN_WIDTH_KPH), bins.length - 1);
    const bin = bins[index];

    if(bin) {
      bin.n++;
    }
  }

  return bins;
}

/**
 * Traffic by hour of day, in the server's local time.
 *
 * All 24 hours are returned even when empty: the gaps are the point. A street with a 3 a.m. outlier
 * and nothing either side reads very differently from one with steady overnight traffic, and a
 * chart that omitted the empty hours would draw both the same.
 */
export function byHourOfDay(passes: readonly Pass[]): HourBucket[] {
  const buckets: number[][] = Array.from({ length: 24 }, () => []);

  for(const pass of passes) {
    (buckets[new Date(pass.atMs).getHours()] as number[]).push(pass.speedKph);
  }

  return buckets.map((speeds, hour) => ({ hour, meanKph: mean(speeds), n: speeds.length }));
}

/**
 * Split by direction of travel.
 *
 * The road runs along ground +X, so a heading within 90 degrees of +X is one way down the street
 * and anything else is the other. Speeding is often direction-dependent - a downhill run, or the
 * approach to a junction where nobody slows - and an aggregate over both directions hides it.
 */
export function byDirection(passes: readonly Pass[], labels: readonly [string, string]):
  [DirectionSplit, DirectionSplit] {

  const forward: Pass[] = [];
  const backward: Pass[] = [];

  for(const pass of passes) {
    // Fold the heading onto [-180, 180) before comparing, so 350 degrees counts as -10 rather than
    // falling out the far side of the test.
    const heading = ((pass.directionDeg % 360) + 540) % 360 - 180;

    (Math.abs(heading) <= 90 ? forward : backward).push(pass);
  }

  const split = (group: Pass[], label: string): DirectionSplit => {
    const speeds = group.map((p) => p.speedKph).sort((a, b) => a - b);

    return { label, meanKph: mean(speeds), n: speeds.length, p85Kph: percentile(speeds, 0.85) };
  };

  return [ split(forward, labels[0]), split(backward, labels[1]) ];
}

/**
 * Order the passes before the page limit is applied.
 *
 * The limit is what makes this belong on the server: sorting the first 500 rows of a newest-first
 * list by speed would label the fastest of those few "the fastest", which is a quietly wrong answer
 * rather than a missing one.
 */
export function sortPasses(passes: Pass[], sort: PassSort, direction: SortDirection): Pass[] {
  const sign = direction === "asc" ? 1 : -1;

  return [ ...passes ].sort((a, b) => sort === "speed"
    // Ties on speed fall back to time, so equal readings keep a stable, meaningful order.
    ? (sign * (a.speedKph - b.speedKph)) || (b.atMs - a.atMs)
    : sign * (a.atMs - b.atMs));
}
