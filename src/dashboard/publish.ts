/**
 * Build a publishable copy of the dashboard.
 *
 * The live dashboard answers questions from a database; a published one cannot, so this renders the
 * answers ahead of time - one JSON file per range and dedupe setting, in exactly the shape the API
 * returns - and lays them beside the same compiled components. The page cannot tell the difference,
 * which is the point: there is one dashboard here, not two that drift apart.
 *
 * What does not come across is anything pointing back at the house. `protectUrl` carries the
 * controller's address on every single row, and stripping it here rather than in the database keeps
 * the local dashboard's audit trail intact.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync }
  from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPasses, buildSummary, collectPasses, ensureUiBuilt, UI_OUT } from "./server.js";
import { RANGES } from "./types.js";
import type { Pass, RangeKey } from "./types.js";
import type { Config } from "../config.js";
import type { Store } from "../db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directories the export owns outright and will replace. Nothing else in the output is touched. */
const OWNED = [ "api", "ui" ];

export interface PublishResult {
  dir: string;
  files: number;
  bytes: number;
  generatedAtMs: number;
  /** Passes written for the widest range, which is the whole published record. */
  passes: number;
}

function round(value: number, places: number): number {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
}

/**
 * One pass, as published.
 *
 * Two things happen here. `protectUrl` goes, because it is `https://<controller>/protect/events/...`
 * and is the only field in the payload that describes the user's network rather than the street.
 *
 * And the numbers are cut to the precision the page actually shows. The API emits raw doubles -
 * `atMs: 1788905355060.667`, `directionDeg: -2.5203525969456826` - which is ~435 bytes a row of
 * which the reader sees maybe forty. Rounding here rather than at render time also means the charts
 * and the table are computed from identical values and cannot disagree in the last digit.
 */
export function publicPass(pass: Pass): Pass {
  const { protectUrl: _protectUrl, ...rest } = pass;

  return {
    ...rest,
    atMs: Math.round(pass.atMs),
    directionDeg: round(pass.directionDeg, 1),
    distanceM: round(pass.distanceM, 2),
    durationS: round(pass.durationS, 2),
    quality: round(pass.quality, 4),
    r2: round(pass.r2, 4),
    speedKph: round(pass.speedKph, 2),
    speedMph: round(pass.speedMph, 2)
  };
}

/**
 * Refuse to write into a directory that is not ours.
 *
 * The output path is a command-line flag, and this function deletes subtrees inside it. An empty or
 * absent directory is fair game, and so is one we have written before - anything else, the caller
 * has almost certainly mistyped a path, and finding out by losing files is not acceptable.
 */
function checkOutDir(dir: string): void {
  if(!existsSync(dir) || (readdirSync(dir).length === 0)) {
    return;
  }

  const marker = resolve(dir, "index.html");

  if(existsSync(marker) && readFileSync(marker, "utf8").includes("data-mode=\"static\"")) {
    return;
  }

  throw new Error(dir + " already has files in it that this command did not write. " +
    "Point --out at an empty directory.");
}

function bytesUnder(dir: string): { files: number; bytes: number } {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => ({
      bytes: total.bytes + statSync(resolve(entry.parentPath, entry.name)).size,
      files: total.files + 1
    }), { bytes: 0, files: 0 });
}

export function exportSite(store: Store, cfg: Config, outDir: string): PublishResult {
  checkOutDir(outDir);
  ensureUiBuilt();

  for(const owned of OWNED) {
    rmSync(resolve(outDir, owned), { force: true, recursive: true });
  }

  mkdirSync(resolve(outDir, "api"), { recursive: true });

  // The compiled components, verbatim and at the same paths the local server serves them from, so a
  // URL that works on 127.0.0.1 works on the public site. Source maps stay behind: they are of no
  // use to a visitor and they name paths on the machine that built them.
  cpSync(UI_OUT, outDir, { filter: (from) => !from.endsWith(".map"), recursive: true });

  // The published page reads snapshots and has no route to the controller. This one attribute is
  // what tells it so; `src/dashboard/ui/source.ts` is the only thing that reads it.
  const page = readFileSync(resolve(HERE, "page.html"), "utf8");

  if(!page.includes("data-mode=\"live\"")) {
    throw new Error("page.html no longer declares data-mode=\"live\" - the export cannot switch it.");
  }

  writeFileSync(resolve(outDir, "index.html"),
    page.replace("data-mode=\"live\"", "data-mode=\"static\""));

  // The hour buckets and every timestamp are in this machine's zone. A reader in another one needs
  // to be told, or the page silently shifts the morning rush.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const generatedAtMs = Date.now();
  let widest = 0;

  for(const range of RANGES) {
    for(const dedupe of [ true, false ]) {
      const collected = collectPasses(store, cfg, range as RangeKey, dedupe);
      const passes = collected.passes.map(publicPass);
      const rounded = { ...collected, passes };
      const name = "-" + range + "-" + (dedupe ? "1" : "0") + ".json";

      const summary = { ...buildSummary(cfg, range as RangeKey, dedupe, rounded), generatedAtMs,
        timeZone };

      // Every pass in the range, unsorted and uncapped: with no server to re-sort, the browser can
      // only honestly call a row "the fastest" if it was given all of them to choose from.
      const table = buildPasses(cfg, range as RangeKey, dedupe, rounded, "time", "desc",
        passes.length, false);

      writeFileSync(resolve(outDir, "api", "summary" + name), JSON.stringify(summary));
      writeFileSync(resolve(outDir, "api", "passes" + name), JSON.stringify(table));

      widest = Math.max(widest, passes.length);
    }
  }

  return { ...bytesUnder(outDir), dir: outDir, generatedAtMs, passes: widest };
}
