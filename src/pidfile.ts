/**
 * Track a long-running command so a later invocation can stop it.
 *
 * The hard part of a pid file is not writing it, it is trusting it. A process that was killed
 * outright, or that died with the machine, leaves the file behind - and the operating system reuses
 * pids, so the number in a stale file eventually belongs to something else entirely. Acting on it
 * would mean signalling an innocent process, which is a far worse failure than being unable to stop
 * the one you meant.
 *
 * So the record stores the command line the process was running, and a pid is only believed while
 * the process under it still matches. Nothing here sends a signal on the strength of a number alone.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { ROOT } from "./config.js";

export interface PidRecord {
  pid: number;
  startedAtMs: number;
  port: number;
  /** The command line at claim time. The pid is ours only while it still runs this. */
  command: string;
}

export type StopOutcome = "not-running" | "stopped" | "forced";

export interface StopResult {
  outcome: StopOutcome;
  pids: number[];
  port?: number;
  /** True when the process was found by searching, because there was no usable pid file. */
  bySearch: boolean;
}

/** How long to let a process shut down cleanly before insisting. */
const GRACE_MS = 5000;

export function pidPath(name: string): string {
  return resolve(ROOT, "data", name + ".pid");
}

/** The command line a pid is running, or undefined when nothing is running under it. */
function commandLine(pid: number): string | undefined {
  const result = spawnSync("ps", [ "-o", "command=", "-p", String(pid) ], { encoding: "utf8" });
  const line = (result.stdout ?? "").trim();

  return line === "" ? undefined : line;
}

/**
 * The record for a process that is genuinely still running, or undefined.
 *
 * A file that fails the check is deleted on the way out: it describes a process that no longer
 * exists, and leaving it would have the next run reach the same wrong answer.
 */
export function livePid(name: string): PidRecord | undefined {
  let record: PidRecord;

  try {
    record = JSON.parse(readFileSync(pidPath(name), "utf8")) as PidRecord;
  } catch {
    return undefined;
  }

  if((typeof record.pid !== "number") || (typeof record.command !== "string")) {
    return undefined;
  }

  if(commandLine(record.pid) === record.command) {
    return record;
  }

  rmSync(pidPath(name), { force: true });

  return undefined;
}

/**
 * Claim the pid file for this process, returning the function that releases it.
 *
 * The release is wired to the signals a foreground command actually receives, so Ctrl-C leaves
 * nothing behind. SIGKILL cannot be caught, which is precisely why `livePid` verifies rather than
 * trusts.
 */
export function claim(name: string, port: number, onSignal: () => void): () => void {
  const path = pidPath(name);

  const record: PidRecord = {
    command: commandLine(process.pid) ?? process.argv.join(" "),
    pid: process.pid,
    port,
    startedAtMs: Date.now()
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));

  let released = false;

  const release = (): void => {
    if(!released) {
      released = true;
      rmSync(path, { force: true });
    }
  };

  process.once("exit", release);

  for(const signal of [ "SIGINT", "SIGTERM" ] as const) {
    process.once(signal, () => {
      release();
      onSignal();
    });
  }

  return release;
}

/**
 * Find running processes by command line, for when there is no pid file to go on.
 *
 * This covers what a pid file cannot: a process started before pid files existed, or started some
 * other way. The pattern must be narrow enough that it cannot match anything else on the machine,
 * so callers anchor it on this project's own entry point rather than on a word like "dashboard".
 */
function search(pattern: string): number[] {
  const result = spawnSync("pgrep", [ "-f", pattern ], { encoding: "utf8" });

  return (result.stdout ?? "").split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && (pid > 0) && (pid !== process.pid));
}

function gone(pid: number): boolean {
  return commandLine(pid) === undefined;
}

async function waitForExit(pids: readonly number[]): Promise<boolean> {
  for(let waited = 0; waited < GRACE_MS; waited += 100) {
    if(pids.every(gone)) {
      return true;
    }

    await new Promise((tick) => setTimeout(tick, 100));
  }

  return pids.every(gone);
}

function signal(pid: number, using: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, using);
  } catch {
    // Already gone between the check and the signal, which is the outcome we wanted.
  }
}

/**
 * Stop the process named by the pid file, falling back to a search.
 *
 * SIGTERM first, so the server can close its listener and its database handle; SIGKILL only if it
 * is still there after the grace period. The two are reported separately because needing the second
 * one means the process did not shut down cleanly, which is worth knowing.
 */
export async function stop(name: string, searchPattern: string): Promise<StopResult> {
  const record = livePid(name);
  const pids = record ? [ record.pid ] : search(searchPattern);
  const bySearch = record === undefined;

  if(pids.length === 0) {
    return { bySearch, outcome: "not-running", pids: [] };
  }

  const found = { bySearch, pids, ...(record ? { port: record.port } : {}) };

  for(const pid of pids) {
    signal(pid, "SIGTERM");
  }

  const exited = await waitForExit(pids);

  if(!exited) {
    for(const pid of pids.filter((pid) => !gone(pid))) {
      signal(pid, "SIGKILL");
    }

    await waitForExit(pids);
  }

  rmSync(pidPath(name), { force: true });

  return { ...found, outcome: exited ? "stopped" : "forced" };
}
