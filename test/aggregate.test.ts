import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BIN_WIDTH_KPH, byDirection, byHourOfDay, histogram, percentile, sortPasses, speedStats }
  from "../src/dashboard/aggregate.js";
import { dedupePasses } from "../src/dedupe.js";
import type { CandidatePass } from "../src/dedupe.js";
import type { Pass } from "../src/dashboard/types.js";
import { ROOT } from "../src/config.js";

const REAL: CandidatePass[] = JSON.parse(
  readFileSync(resolve(ROOT, "test", "fixtures", "passes.json"), "utf8")) as CandidatePass[];

const RAW: Pass[] = REAL.map(({ endMs: _endMs, ...pass }) => pass);

const LIMIT = 30;

function speeds(values: number[]): Pass[] {
  return values.map((speedKph, index) => ({
    atMs: Date.parse("2026-09-08T11:00:00Z") + index * 60_000,
    cls: "car",
    directionDeg: 0,
    distanceM: 11,
    durationS: 1.5,
    eventId: "e" + index,
    mergedFrom: 1,
    nPoints: 40,
    protectUrl: "https://nvr/e" + index,
    quality: 0.9,
    r2: 0.99,
    speedKph,
    speedMph: speedKph / 1.609,
    trackId: 1
  }));
}

describe("percentile", () => {
  it("interpolates between neighbouring ranks", () => {
    // Rank 0.85 * 3 = 2.55, so 85% sits 55% of the way from 30 to 40.
    expect(percentile([ 10, 20, 30, 40 ], 0.85)).toBeCloseTo(35.5, 6);
  });

  it("returns the endpoints exactly", () => {
    expect(percentile([ 10, 20, 30 ], 0)).toBe(10);
    expect(percentile([ 10, 20, 30 ], 1)).toBe(30);
  });

  it("returns zero for no samples rather than NaN", () => {
    expect(percentile([], 0.85)).toBe(0);
  });
});

describe("speedStats", () => {
  it("reproduces the figures confirmed from the real backfill", () => {
    const stats = speedStats(RAW, LIMIT);

    expect(stats.n).toBe(52);
    expect(stats.meanKph).toBeCloseTo(23.7, 1);
    expect(stats.medianKph).toBeCloseTo(23.6, 1);
    // Interpolated between the 44th and 45th samples (27.70 and 27.87). Picking the nearer rank
    // instead would report 27.87, and with only 52 samples that choice is worth being explicit
    // about - it moves the headline figure by more than a tenth.
    expect(stats.p85Kph).toBeCloseTo(27.76, 2);
    expect(stats.minKph).toBeCloseTo(14.8, 1);
    expect(stats.maxKph).toBeCloseTo(35.2, 1);
  });

  it("counts passes strictly above the limit", () => {
    const stats = speedStats(speeds([ 29.9, 30, 30.1, 40 ]), LIMIT);

    expect(stats.overLimit).toBe(2);
    expect(stats.overLimitShare).toBeCloseTo(0.5, 6);
  });

  it("survives an empty range without dividing by zero", () => {
    const stats = speedStats([], LIMIT);

    expect(stats).toMatchObject({ maxKph: 0, meanKph: 0, n: 0, overLimit: 0, overLimitShare: 0 });
  });
});

describe("histogram", () => {
  it("puts each speed in the band that contains it", () => {
    const bins = histogram(speeds([ 0.5, 2, 3.9, 4 ]), LIMIT);

    expect(bins[0]).toMatchObject({ fromKph: 0, n: 1, toKph: BIN_WIDTH_KPH });
    expect(bins[1]?.n).toBe(2);
    expect(bins[2]?.n).toBe(1);
  });

  it("always starts at zero and reaches past the limit, even with no traffic", () => {
    const bins = histogram([], LIMIT);

    expect(bins[0]?.fromKph).toBe(0);
    expect(bins[bins.length - 1]?.toKph).toBeGreaterThan(LIMIT);
  });

  it("extends to cover the fastest pass", () => {
    const bins = histogram(speeds([ 88 ]), LIMIT);

    expect(bins[bins.length - 1]?.toKph).toBeGreaterThanOrEqual(88);
    expect(bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(1);
  });

  it("bins every real pass exactly once", () => {
    expect(histogram(RAW, LIMIT).reduce((sum, bin) => sum + bin.n, 0)).toBe(RAW.length);
  });
});

describe("byHourOfDay", () => {
  it("returns all 24 hours so empty ones stay visible", () => {
    const buckets = byHourOfDay(RAW);

    expect(buckets).toHaveLength(24);
    expect(buckets.map((bucket) => bucket.hour)).toEqual([ ...Array(24).keys() ]);
    expect(buckets.reduce((sum, bucket) => sum + bucket.n, 0)).toBe(RAW.length);
  });

  it("reports a mean of zero, not NaN, for an hour with no traffic", () => {
    const quiet = byHourOfDay(RAW).filter((bucket) => bucket.n === 0);

    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((bucket) => bucket.meanKph === 0)).toBe(true);
  });
});

describe("byDirection", () => {
  const LABELS: [string, string] = [ "One way", "The other way" ];

  it("splits the real backfill 36 / 16", () => {
    const [ forward, backward ] = byDirection(RAW, LABELS);

    expect(forward.n).toBe(36);
    expect(backward.n).toBe(16);
    expect(forward.label).toBe("One way");
  });

  it("counts every pass exactly once", () => {
    const [ forward, backward ] = byDirection(RAW, LABELS);

    expect(forward.n + backward.n).toBe(RAW.length);
  });

  it("treats a heading just under 360 as the forward direction", () => {
    const [ forward ] = byDirection(speeds([ 25 ]).map((p) => ({ ...p, directionDeg: 358 })), LABELS);

    expect(forward.n).toBe(1);
  });
});

describe("deduping and aggregation together", () => {
  it("leaves the shape of the distribution intact", () => {
    // Merging duplicates should remove readings, not move the street's speed profile: the six
    // duplicated vehicles were ordinary traffic, so the summary must barely shift.
    const deduped = dedupePasses(REAL);
    const before = speedStats(RAW, LIMIT);
    const after = speedStats(deduped, LIMIT);

    expect(after.n).toBe(46);
    expect(after.medianKph).toBeCloseTo(before.medianKph, 0);
    expect(Math.abs(after.p85Kph - before.p85Kph)).toBeLessThan(1);
  });
});

describe("sortPasses", () => {
  it("orders by speed, fastest first", () => {
    const sorted = sortPasses(speeds([ 20, 40, 30 ]), "speed", "desc");

    expect(sorted.map((p) => p.speedKph)).toEqual([ 40, 30, 20 ]);
  });

  it("orders by speed, slowest first", () => {
    const sorted = sortPasses(speeds([ 20, 40, 30 ]), "speed", "asc");

    expect(sorted.map((p) => p.speedKph)).toEqual([ 20, 30, 40 ]);
  });

  it("breaks speed ties with the newer pass", () => {
    // Without a tie-break, equal readings come out in whatever order the database happened to
    // return them, and the table shuffles between identical-looking refreshes.
    const [ older, newer ] = speeds([ 25, 25 ]) as [ Pass, Pass ];
    const sorted = sortPasses([ older, newer ], "speed", "desc");

    expect(sorted[0]?.atMs).toBe(newer.atMs);
    expect(sortPasses([ newer, older ], "speed", "desc")[0]?.atMs).toBe(newer.atMs);
  });

  it("orders by time in both directions", () => {
    const passes = speeds([ 20, 30, 40 ]);

    expect(sortPasses(passes, "time", "desc").map((p) => p.speedKph)).toEqual([ 40, 30, 20 ]);
    expect(sortPasses(passes, "time", "asc").map((p) => p.speedKph)).toEqual([ 20, 30, 40 ]);
  });

  it("does not mutate its input", () => {
    const passes = speeds([ 20, 40, 30 ]);

    sortPasses(passes, "speed", "desc");

    expect(passes.map((p) => p.speedKph)).toEqual([ 20, 40, 30 ]);
  });

  it("finds the fastest across the whole range, not just the newest page", () => {
    // The reason this runs on the server: a page of the newest 3 would miss the 40 entirely.
    const passes = speeds([ 40, 21, 22, 23 ]);
    const page = sortPasses(passes, "speed", "desc").slice(0, 3);

    expect(page[0]?.speedKph).toBe(40);
  });
});
