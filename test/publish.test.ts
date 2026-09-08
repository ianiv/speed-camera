import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync }
  from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { publicPass } from "../src/dashboard/publish.js";
import { speedStats } from "../src/dashboard/aggregate.js";
import { dedupePasses } from "../src/dedupe.js";
import type { CandidatePass } from "../src/dedupe.js";
import { RANGES } from "../src/dashboard/types.js";
import type { Pass } from "../src/dashboard/types.js";
import { ROOT } from "../src/config.js";

const REAL: CandidatePass[] = JSON.parse(
  readFileSync(resolve(ROOT, "test", "fixtures", "passes.json"), "utf8")) as CandidatePass[];

const scratch = mkdtempSync(resolve(tmpdir(), "publish-"));

afterAll(() => rmSync(scratch, { force: true, recursive: true }));

describe("publicPass", () => {
  it("drops the link that names the controller", () => {
    // The single most important line in this file. `protectUrl` is
    // https://<the controller>/protect/events/... on every row, so publishing it would put the
    // address of the user's camera system on the public internet once per vehicle.
    const published = publicPass(REAL[0] as Pass);

    expect((REAL[0] as Pass).protectUrl).toBeTruthy();
    expect(published.protectUrl).toBeUndefined();
    expect(Object.keys(published)).not.toContain("protectUrl");
    expect(JSON.stringify(published)).not.toContain("protect");
  });

  it("keeps every measured value the page displays", () => {
    const source = REAL[0] as Pass;
    const published = publicPass(source);

    expect(published.cls).toBe(source.cls);
    expect(published.nPoints).toBe(source.nPoints);
    expect(published.trackId).toBe(source.trackId);
    expect(published.mergedFrom).toBe(source.mergedFrom);
    expect(published.speedKph).toBeCloseTo(source.speedKph, 2);
    expect(published.atMs).toBeCloseTo(source.atMs, -1);
  });

  it("rounds to the precision the page actually shows", () => {
    const published = publicPass({ ...REAL[0] as Pass,
      atMs: 1_788_905_355_060.667, directionDeg: -2.5203525969456826, speedKph: 34.54161921233619 });

    expect(published.atMs).toBe(1_788_905_355_061);
    expect(published.directionDeg).toBe(-2.5);
    expect(published.speedKph).toBe(34.54);
  });

  it("leaves no number longer than the page can display", () => {
    // Not cosmetic: every visitor downloads every row of the range they pick, and the raw doubles
    // are mostly digits nobody reads - `directionDeg: -2.5203525969456826` for a figure shown to one
    // decimal place. Asserting the digits rather than a byte count, because the fixture's ids are
    // anonymised and short, so a size ratio measured here would not be the one real data gets.
    for(const pass of REAL.map(publicPass)) {
      for(const [ field, value ] of Object.entries(pass)) {
        if(typeof value === "number") {
          expect(String(value).split(".")[1]?.length ?? 0, field + "=" + value)
            .toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it("leaves the statistics where they were", () => {
    // Rounding happens before the summary is computed, so the charts and the table are built from
    // identical numbers - but it must not move the headline figures either.
    const raw = REAL.map(({ endMs: _endMs, ...pass }) => pass);
    const before = speedStats(raw, 30);
    const after = speedStats(raw.map(publicPass), 30);

    expect(after.n).toBe(before.n);
    expect(after.overLimit).toBe(before.overLimit);
    expect(after.p85Kph).toBeCloseTo(before.p85Kph, 2);
    expect(after.medianKph).toBeCloseTo(before.medianKph, 2);
    expect(after.maxKph).toBeCloseTo(before.maxKph, 2);
  });

  it("survives a pass that has no link to begin with", () => {
    // Published rows are `Pass` too, so re-publishing one must not produce `protectUrl: undefined`.
    const twice = publicPass(publicPass(REAL[0] as Pass));

    expect(Object.keys(twice)).not.toContain("protectUrl");
  });

  it("does not disturb deduping", () => {
    const raw = dedupePasses(REAL);
    const rounded = dedupePasses(REAL.map((pass) => ({ ...publicPass(pass), endMs: pass.endMs })));

    expect(rounded).toHaveLength(raw.length);
    expect(rounded.filter((p) => p.mergedFrom > 1)).toHaveLength(6);
  });
});

/**
 * The guard on the output directory.
 *
 * `exportSite` deletes subtrees inside a path that came from a command-line flag, so a mistyped
 * `--out` has to fail loudly rather than eat somebody's files.
 */
describe("the output directory guard", () => {
  it("refuses a directory it did not write", async () => {
    const { exportSite } = await import("../src/dashboard/publish.js");
    const occupied = resolve(scratch, "occupied");

    mkdirSync(occupied, { recursive: true });
    writeFileSync(resolve(occupied, "notes.txt"), "someone's work");

    expect(() => exportSite(null as never, null as never, occupied)).toThrow(/did not write/);
    expect(readdirSync(occupied)).toContain("notes.txt");
  });
});

describe("the page shell", () => {
  const page = readFileSync(resolve(ROOT, "src", "dashboard", "page.html"), "utf8");

  it("declares the mode the exporter rewrites", () => {
    // `exportSite` swaps this one attribute, and throws if it is missing rather than shipping a
    // page that quietly tries to fetch /api from a CDN.
    expect(page).toContain("data-mode=\"live\"");
  });

  it("loads its assets from the paths both deployments serve", () => {
    expect(page).toContain("/ui/app.js");
    expect(page).toContain("/ui/style.css");
  });
});

/**
 * The last line of defence, run against a real export.
 *
 * Everything above tests one function. This reads every byte that would actually be uploaded and
 * looks for the things that must never be on it. It needs `ufp-speed publish` to have been run, so
 * it skips on a clean checkout - where there is no database to export and nothing to leak.
 */
const PUBLIC = resolve(ROOT, "public");
const exported = existsSync(resolve(PUBLIC, "index.html"));

describe.skipIf(!exported)("a real export", () => {
  const files = readdirSync(PUBLIC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: resolve(entry.parentPath, entry.name).slice(PUBLIC.length + 1),
      text: readFileSync(resolve(entry.parentPath, entry.name), "utf8")
    }));

  const data = files.filter((file) => file.name.endsWith(".json"));

  it("carries no address, id or route belonging to the controller", () => {
    const forbidden = [ /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /protectUrl/, /protect\/events/, /api\/clip/ ];

    for(const file of data) {
      for(const pattern of forbidden) {
        expect(file.name + " matched " + String(pattern) + ": " +
          (pattern.exec(file.text)?.[0] ?? "")).toBe(file.name + " matched " + String(pattern) + ": ");
      }
    }
  });

  it("is a static page, not a copy of the live one", () => {
    const index = files.find((file) => file.name === "index.html");

    expect(index?.text).toContain("data-mode=\"static\"");
    expect(index?.text).not.toContain("data-mode=\"live\"");
  });

  it("ships a summary and a pass list for every range and dedupe setting", () => {
    expect(data).toHaveLength(RANGES.length * 4);

    for(const file of data) {
      const body = JSON.parse(file.text) as { stats?: { n: number }; passes?: Pass[];
        playback?: boolean; timeZone?: string };

      if(body.passes) {
        expect(body.playback, file.name).toBe(false);
      } else {
        expect(body.timeZone, file.name).toBeTruthy();
      }
    }
  });

  it("gives the table every row it needs to sort honestly", () => {
    // The live dashboard sorts on the server because it only sends a page of rows. A snapshot has
    // no server, so the file has to hold the whole range or "fastest" is a claim about a sample.
    for(const file of data.filter((entry) => entry.name.includes("passes-"))) {
      const body = JSON.parse(file.text) as { passes: Pass[]; total: number };

      expect(body.passes.length, file.name).toBe(body.total);
    }
  });

  it("agrees with its own summary", () => {
    for(const file of data.filter((entry) => entry.name.includes("passes-"))) {
      const passes = (JSON.parse(file.text) as { passes: Pass[] }).passes;
      const summary = JSON.parse(files.find((entry) =>
        entry.name === file.name.replace("passes-", "summary-"))?.text ?? "{}") as
        { stats: { n: number; p85Kph: number } };

      expect(summary.stats.n, file.name).toBe(passes.length);
      expect(summary.stats.p85Kph).toBeCloseTo(speedStats(passes, 30).p85Kph, 6);
    }
  });

  it("does not publish source maps", () => {
    expect(files.filter((file) => file.name.endsWith(".map"))).toHaveLength(0);
  });
});
