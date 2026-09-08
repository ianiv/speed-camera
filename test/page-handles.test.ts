import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The calibration page's hit-testing and point-editing, exercised as the page actually defines it.
 *
 * These are the parts a mis-click lands on: grabbing the wrong point, or an arrow-key nudge writing
 * to the wrong list, would corrupt a calibration in ways that only show up later as wrong speeds.
 */
function loadHandles(state: {
  points: number[][]; roi: number[][]; lensLines: number[][][]; currentLine: number[][];
}) {
  const html = readFileSync(resolve(import.meta.dirname, "../src/calibrate/page.html"), "utf8");
  const start = html.indexOf("function toCanvas(event)");
  const end = html.indexOf("canvas.addEventListener(\"pointerdown\"");

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  // A 3840-wide frame shown 960 wide: one screen pixel covers four image pixels, as in reality.
  const canvas = { getBoundingClientRect: () => ({ height: 540, left: 0, top: 0, width: 960 }),
    height: 2160, style: {}, width: 3840 };

  const factory = new Function("canvas", "points", "roi", "lensLines", "currentLine",
    "let lens = null, lensReport = null;\n" +
    "const solveLensFrom = () => null, lensStatus = () => {};\n" +
    html.slice(start, end) +
    "return { toCanvas, screenScale, grabRadius, handleAt, sameHandle, readHandle, writeHandle, removeHandle };");

  return factory(canvas, state.points, state.roi, state.lensLines, state.currentLine);
}

describe("calibration page point handles", () => {
  let state: { points: number[][]; roi: number[][]; lensLines: number[][][]; currentLine: number[][] };
  let h: ReturnType<typeof loadHandles>;

  beforeEach(() => {
    state = {
      currentLine: [],
      lensLines: [ [ [ 100, 100 ], [ 500, 120 ], [ 900, 140 ] ] ],
      points: [ [ 400, 1500 ], [ 3400, 1500 ], [ 2900, 700 ], [ 900, 700 ] ],
      roi: [ [ 0, 800 ], [ 3840, 800 ], [ 3840, 2000 ] ]
    };
    h = loadHandles(state);
  });

  it("scales screen coordinates to image pixels", () => {
    expect(h.screenScale()).toBe(4);
    expect(h.toCanvas({ clientX: 100, clientY: 50 })).toEqual([ 400, 200 ]);
  });

  it("grabs a quad point when clicked near it", () => {
    expect(h.handleAt([ 405, 1495 ])).toEqual({ index: 0, kind: "quad" });
  });

  it("grabs nothing in empty space", () => {
    expect(h.handleAt([ 2000, 1800 ])).toBeNull();
  });

  it("grabs the nearest point when two are close", () => {
    state.points[0] = [ 1000, 1000 ];
    state.points[1] = [ 1030, 1000 ];

    expect(h.handleAt([ 1025, 1000 ])).toEqual({ index: 1, kind: "quad" });
  });

  it("identifies roi vertices and lens trace points distinctly", () => {
    expect(h.handleAt([ 0, 800 ])).toEqual({ index: 0, kind: "roi" });
    expect(h.handleAt([ 500, 120 ])).toEqual({ index: 1, kind: "lens", line: 0 });
  });

  it("writes a moved point back to the list it came from", () => {
    const handle = h.handleAt([ 500, 120 ]);

    h.writeHandle(handle, [ 505, 133 ]);

    expect(state.lensLines[0]?.[1]).toEqual([ 505, 133 ]);
    // Nothing else may move.
    expect(state.points[0]).toEqual([ 400, 1500 ]);
    expect(h.readHandle(handle)).toEqual([ 505, 133 ]);
  });

  it("has a grab radius that scales with the display, so it stays clickable when zoomed out", () => {
    expect(h.grabRadius()).toBe(56);
    expect(h.handleAt([ 400 + 50, 1500 ])).toEqual({ index: 0, kind: "quad" });
    expect(h.handleAt([ 400 + 60, 1500 ])).toBeNull();
  });

  it("deletes a roi vertex without touching the others", () => {
    h.removeHandle({ index: 1, kind: "roi" });

    expect(state.roi).toEqual([ [ 0, 800 ], [ 3840, 2000 ] ]);
  });

  it("drops a lens trace that falls below 3 points, since it can no longer show curvature", () => {
    h.removeHandle({ index: 0, kind: "lens", line: 0 });

    expect(state.lensLines).toHaveLength(0);
  });

  it("compares handles by identity, not by value", () => {
    expect(h.sameHandle({ index: 0, kind: "quad" }, { index: 0, kind: "quad" })).toBe(true);
    expect(h.sameHandle({ index: 0, kind: "quad" }, { index: 0, kind: "roi" })).toBe(false);
    expect(h.sameHandle({ index: 0, kind: "lens", line: 0 }, { index: 0, kind: "lens", line: 1 })).toBe(false);
    expect(h.sameHandle(null, { index: 0, kind: "quad" })).toBeFalsy();
  });
});
