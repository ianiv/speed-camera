import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { claim, livePid, pidPath, stop } from "../src/pidfile.js";

const NAME = "test-pidfile";
const PATH = pidPath(NAME);

const started: ChildProcess[] = [];

/** A process that will sit there until told otherwise, standing in for a real long-running command. */
function sleeper(): ChildProcess {
  const child = spawn("sleep", [ "120" ], { stdio: "ignore" });

  started.push(child);

  return child;
}

afterEach(() => {
  rmSync(PATH, { force: true });

  for(const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
});

describe("livePid", () => {
  it("returns nothing when there is no file", () => {
    expect(livePid(NAME)).toBeUndefined();
  });

  it("returns nothing for a file that is not valid JSON", () => {
    writeFileSync(PATH, "not json");

    expect(livePid(NAME)).toBeUndefined();
  });

  it("recognises the process that wrote the file", () => {
    const release = claim(NAME, 8738, () => undefined);
    const record = livePid(NAME);

    expect(record?.pid).toBe(process.pid);
    expect(record?.port).toBe(8738);
    expect(record?.command).toBeTruthy();

    release();
    expect(existsSync(PATH)).toBe(false);
  });

  it("refuses a pid that is running something else, and deletes the file", () => {
    // The whole reason this module exists. Pids get reused, so a stale file eventually names a
    // live process that has nothing to do with us - and acting on it would signal a stranger.
    const other = sleeper();

    writeFileSync(PATH, JSON.stringify({
      command: "node dist/cli.js dashboard", pid: other.pid, port: 8738, startedAtMs: Date.now()
    }));

    expect(livePid(NAME)).toBeUndefined();
    expect(existsSync(PATH)).toBe(false);
    expect(other.killed).toBe(false);
  });

  it("refuses a pid that is not running at all", () => {
    const dead = sleeper();
    const pid = dead.pid as number;

    dead.kill("SIGKILL");

    return new Promise<void>((done) => dead.once("exit", () => {
      writeFileSync(PATH, JSON.stringify({
        command: "sleep 120", pid, port: 8738, startedAtMs: Date.now()
      }));

      expect(livePid(NAME)).toBeUndefined();
      done();
    }));
  });
});

describe("stop", () => {
  it("reports nothing to do when nothing is running", async () => {
    const result = await stop(NAME, "a-pattern-matching-nothing-xyzzy");

    expect(result.outcome).toBe("not-running");
    expect(result.pids).toEqual([]);
  });

  it("stops the process the file names, and cleans up after it", async () => {
    const child = sleeper();

    writeFileSync(PATH, JSON.stringify({
      command: "sleep 120", pid: child.pid, port: 8738, startedAtMs: Date.now()
    }));

    const result = await stop(NAME, "no-search-needed-xyzzy");

    expect(result.outcome).toBe("stopped");
    expect(result.pids).toEqual([ child.pid ]);
    expect(result.port).toBe(8738);
    expect(result.bySearch).toBe(false);
    expect(existsSync(PATH)).toBe(false);
  });

  it("leaves an unrelated process alone when the file is stale", async () => {
    const bystander = sleeper();

    writeFileSync(PATH, JSON.stringify({
      command: "node dist/cli.js dashboard", pid: bystander.pid, port: 8738, startedAtMs: Date.now()
    }));

    const result = await stop(NAME, "a-pattern-matching-nothing-xyzzy");

    expect(result.outcome).toBe("not-running");
    expect(bystander.killed).toBe(false);
    expect(bystander.exitCode).toBeNull();
  });

  it("falls back to searching when there is no file", async () => {
    // Covers a dashboard started before pid files existed, or started some other way.
    const child = sleeper();
    const result = await stop(NAME, "sleep 120");

    expect(result.bySearch).toBe(true);
    expect(result.pids).toContain(child.pid);
    expect(result.outcome).toBe("stopped");
  });
});

describe("the record on disk", () => {
  it("stores the command line, which is what makes the pid trustworthy", () => {
    const release = claim(NAME, 9999, () => undefined);
    const record = JSON.parse(readFileSync(PATH, "utf8")) as { command: string; pid: number };

    expect(record.pid).toBe(process.pid);
    expect(record.command).toContain("node");

    release();
  });
});
