import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dedupePasses } from "../src/dedupe.js";
import type { CandidatePass } from "../src/dedupe.js";
import { ROOT } from "../src/config.js";

/**
 * Every accepted measurement from a real one-hour backfill, with each track's clip-relative frame
 * times already resolved onto the wall clock.
 *
 * Synthetic cases cannot show whether the rule works, because the thing being detected - Protect
 * emitting two overlapping events for one vehicle - is a quirk of the controller. These 52 rows
 * contain six such duplications, confirmed by inspecting the footage links.
 *
 * Anonymised before publication: event ids are synthetic, URLs point at a placeholder host, and the
 * timestamps are shifted by a whole number of weeks. Everything the tests assert on - speeds,
 * headings, sample counts, and the relative timing that decides a merge - is untouched.
 */
const REAL: CandidatePass[] = JSON.parse(
  readFileSync(resolve(ROOT, "test", "fixtures", "passes.json"), "utf8")) as CandidatePass[];

function at(time: string): number {
  return Date.parse("2026-09-08T" + time + "Z");
}

/** A pass with sensible defaults, so each test states only the field it is about. */
function pass(overrides: Partial<CandidatePass> & Pick<CandidatePass, "eventId" | "atMs" | "endMs">):
  CandidatePass {

  return {
    cls: "car",
    directionDeg: 0,
    distanceM: 11,
    durationS: 1.5,
    mergedFrom: 1,
    nPoints: 40,
    protectUrl: "https://nvr/protect/events/" + overrides.eventId,
    quality: 0.9,
    r2: 0.998,
    speedKph: 25,
    speedMph: 15.5,
    trackId: 1,
    ...overrides
  };
}

describe("dedupePasses against a real backfill", () => {
  it("collapses the six duplicated passes and keeps everything else", () => {
    const deduped = dedupePasses(REAL);

    expect(REAL).toHaveLength(52);
    expect(deduped).toHaveLength(46);
    expect(deduped.filter((p) => p.mergedFrom > 1)).toHaveLength(6);
  });

  it("keeps the better measurement when two readings of one vehicle disagree", () => {
    // 18:38:40 was measured twice: a 16-point track over 4.5 m said 25.8 km/h, a 43-point track
    // over 11.8 m said 23.6. The longer track is the one to trust, and the one that must survive.
    const merged = dedupePasses(REAL).find((p) => (p.mergedFrom > 1) && (p.nPoints === 43));

    expect(merged).toBeDefined();
    expect(merged?.speedKph).toBeCloseTo(23.6, 1);
    expect(merged?.distanceM).toBeGreaterThan(11);
  });

  it("is idempotent - a deduped set survives a second pass unchanged", () => {
    // Cheap to get wrong: a rule that keeps finding new merges on its own output is one that
    // merges by proximity rather than identity, and would slowly eat real traffic.
    const once = dedupePasses(REAL);

    const again = dedupePasses(once.map((p) => ({
      ...p,
      endMs: (REAL.find((raw) => (raw.eventId === p.eventId) && (raw.trackId === p.trackId)) as CandidatePass).endMs
    })));

    expect(again).toHaveLength(once.length);
    expect(again.map((p) => p.eventId)).toEqual(once.map((p) => p.eventId));
  });

  it("returns newest first", () => {
    const times = dedupePasses(REAL).map((p) => p.atMs);

    expect(times).toEqual([ ...times ].sort((a, b) => b - a));
  });
});

describe("the shape of the data", () => {
  it("has events that produced more than one pass", () => {
    // Load-bearing for the UI: a row is one measured vehicle, but a clip can hold several, so
    // anything keyed on the event id alone - an open video player, say - acts on every vehicle in
    // that clip at once instead of the one that was clicked.
    const perEvent = new Map<string, number>();

    for(const pass of dedupePasses(REAL)) {
      perEvent.set(pass.eventId, (perEvent.get(pass.eventId) ?? 0) + 1);
    }

    expect([ ...perEvent.values() ].some((n) => n > 1)).toBe(true);
  });

  it("identifies a pass uniquely by event and track together", () => {
    const keys = dedupePasses(REAL).map((pass) => pass.eventId + ":" + pass.trackId);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("dedupePasses rules", () => {
  it("merges overlapping passes from different events", () => {
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), endMs: at("11:00:02"), eventId: "a" }),
      pass({ atMs: at("11:00:01"), endMs: at("11:00:03"), eventId: "b" })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.mergedFrom).toBe(2);
  });

  it("keeps two vehicles passing simultaneously in opposite directions", () => {
    // The real case this guard exists for: at 18:25 a motorcycle at 178 degrees and a car at 5
    // degrees crossed at the same instant. Their windows overlap, and without the heading test they
    // would merge into a single phantom vehicle.
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), directionDeg: 5, endMs: at("11:00:03"), eventId: "a" }),
      pass({ atMs: at("11:00:00"), directionDeg: 178, endMs: at("11:00:03"), eventId: "b" })
    ]);

    expect(merged).toHaveLength(2);
  });

  it("treats headings either side of zero as the same direction", () => {
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), directionDeg: 359, endMs: at("11:00:03"), eventId: "a" }),
      pass({ atMs: at("11:00:01"), directionDeg: 3, endMs: at("11:00:04"), eventId: "b" })
    ]);

    expect(merged).toHaveLength(1);
  });

  it("keeps two vehicles of different classes that overlap", () => {
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), cls: "car", endMs: at("11:00:03"), eventId: "a" }),
      pass({ atMs: at("11:00:01"), cls: "truck", endMs: at("11:00:04"), eventId: "b" })
    ]);

    expect(merged).toHaveLength(2);
  });

  it("never merges two tracks from the same event", () => {
    // Within one clip the tracker has already separated the vehicles, so two overlapping tracks
    // there are two real vehicles - a car overtaking another, say.
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), endMs: at("11:00:03"), eventId: "a", trackId: 1 }),
      pass({ atMs: at("11:00:01"), endMs: at("11:00:04"), eventId: "a", trackId: 2 })
    ]);

    expect(merged).toHaveLength(2);
  });

  it("keeps consecutive vehicles whose windows do not overlap", () => {
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), endMs: at("11:00:02"), eventId: "a" }),
      pass({ atMs: at("11:00:02"), endMs: at("11:00:04"), eventId: "b" })
    ]);

    expect(merged).toHaveLength(2);
  });

  it("counts three readings of one vehicle as a single pass", () => {
    const merged = dedupePasses([
      pass({ atMs: at("11:00:00"), endMs: at("11:00:03"), eventId: "a" }),
      pass({ atMs: at("11:00:01"), endMs: at("11:00:04"), eventId: "b", quality: 0.95 }),
      pass({ atMs: at("11:00:02"), endMs: at("11:00:05"), eventId: "c" })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.mergedFrom).toBe(3);
    expect(merged[0]?.quality).toBe(0.95);
  });

  it("handles an empty input", () => {
    expect(dedupePasses([])).toEqual([]);
  });
});
