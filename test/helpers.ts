import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, ROOT } from "../src/config.js";

/**
 * The defaults a real deployment starts from, so a change to config.example.json that breaks the
 * thresholds shows up here. Deliberately does no filesystem writing: vitest runs test files in
 * parallel workers, and a shared temp path between them is a race.
 */
export function loadConfigDefaults() {
  return parseConfig({ ...JSON.parse(readFileSync(resolve(ROOT, "config.example.json"), "utf8")),
    cameraId: "test" }, "config.example.json");
}
