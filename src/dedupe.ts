import type { Pass } from "./dashboard/types.js";

/**
 * Headings must agree within this many degrees for two measurements to be the same vehicle.
 *
 * Not cosmetic: two vehicles genuinely on the road at the same instant, travelling in opposite
 * directions, have overlapping time windows and would otherwise merge into one. That is not
 * hypothetical - a motorcycle at 178 degrees and a car at 5 degrees pass simultaneously in the
 * recorded data.
 */
const HEADING_TOLERANCE_DEG = 20;

/** Smallest angle between two headings, in degrees, accounting for the wrap at 360. */
function headingGap(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;

  return diff > 180 ? 360 - diff : diff;
}

/** Whether two half-open intervals share any instant. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) > Math.max(aStart, bStart);
}

export interface CandidatePass extends Pass {
  /** Wall-clock end of the pass, in epoch ms. `atMs` is its start. */
  endMs: number;
}

/**
 * Collapse measurements of the same vehicle taken from overlapping Protect events.
 *
 * Protect sometimes emits two events for one vehicle, so the same car is downloaded and measured
 * twice. Matching on "same class, similar speed" would be a guess that merges two genuinely
 * different cars; instead this reconstructs each measurement's absolute wall-clock window on the
 * road and merges those that physically coincide. Two measurements are the same pass when they come
 * from different events (within one clip the tracker has already separated the vehicles), their
 * time windows overlap, their class matches, and their headings agree.
 *
 * When duplicates disagree it is because one track is much shorter - a 16-point track over 4.5 m
 * against a 43-point track over 11.8 m - so the survivor is the highest-quality member rather than
 * the first. Nothing is deleted; this is a view over the rows, and the raw ones remain in the
 * database for anyone checking the rule.
 */
export function dedupePasses(passes: readonly CandidatePass[]): Pass[] {
  const byTime = [ ...passes ].sort((a, b) => a.atMs - b.atMs);
  const merged: (CandidatePass & { mergedFrom: number })[] = [];

  for(const pass of byTime) {
    let twin: (CandidatePass & { mergedFrom: number }) | undefined;

    // Walk back from the most recent survivor. The input is sorted by start time, so once a
    // survivor started more than its own duration before this pass, nothing earlier can overlap.
    for(let i = merged.length - 1; i >= 0; i--) {
      const existing = merged[i] as CandidatePass & { mergedFrom: number };

      if(existing.endMs <= pass.atMs) {
        continue;
      }

      if((existing.eventId !== pass.eventId) && (existing.cls === pass.cls) &&
        overlaps(existing.atMs, existing.endMs, pass.atMs, pass.endMs) &&
        (headingGap(existing.directionDeg, pass.directionDeg) <= HEADING_TOLERANCE_DEG)) {
        twin = existing;

        break;
      }
    }

    if(!twin) {
      merged.push({ ...pass, mergedFrom: 1 });

      continue;
    }

    twin.mergedFrom++;

    // Keep the better measurement's numbers, but the earlier window, so the merged pass still spans
    // everything either clip saw of the vehicle.
    if(pass.quality > twin.quality) {
      const { atMs, endMs, mergedFrom } = twin;

      Object.assign(twin, pass, { atMs, endMs: Math.max(endMs, pass.endMs), mergedFrom });
    } else {
      twin.endMs = Math.max(twin.endMs, pass.endMs);
    }
  }

  return merged
    .map(({ endMs: _endMs, ...pass }) => pass)
    .sort((a, b) => b.atMs - a.atMs);
}
