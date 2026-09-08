import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "./config.js";
import type { Config } from "./config.js";
import type { WorkerResult } from "./types.js";
import { log } from "./log.js";

/**
 * Run the Python tracker over a clip and return its raw tracks.
 *
 * The worker's contract is narrow on purpose: it writes one JSON object to a file we name, and
 * narrates on stderr. That keeps the boundary between the two runtimes a data interface rather than
 * shared state, and it survives a library deciding to print to stdout - which Ultralytics does the
 * first time it downloads a model.
 */
export async function analyzeVideo(cfg: Config, videoPath: string,
  opts: { still?: boolean } = {}): Promise<WorkerResult> {
  const python = resolve(ROOT, cfg.worker.python);
  const script = resolve(ROOT, cfg.worker.script);

  if(!existsSync(python)) {
    throw new Error("Python worker interpreter not found at " + python + ". Create it with:\n" +
      "  cd py && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python ultralytics opencv-python-headless lap");
  }

  const outDir = mkdtempSync(join(tmpdir(), "ufp-speed-worker-"));
  const outPath = join(outDir, "tracks.json");

  const args = [ script, "--video", videoPath, "--out", outPath, "--model", cfg.worker.model,
    "--device", cfg.worker.device, "--conf", String(cfg.worker.conf), "--imgsz", String(cfg.worker.imgsz),
    ...(opts.still ? [ "--still" ] : []) ];

  try {
    return await run(python, args, cfg.worker.timeoutMs, outPath);
  } finally {
    rmSync(outDir, { force: true, recursive: true });
  }
}

function run(python: string, args: string[], timeoutMs: number, outPath: string): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolvePromise, reject) => {
    const child = spawn(python, args, { stdio: [ "ignore", "pipe", "pipe" ] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Worker timed out after " + timeoutMs + " ms."));
    }, timeoutMs);

    let stderrTail = "";

    // Whatever the worker or its libraries print to stdout is narration, not result.
    child.stdout.on("data", (chunk: Buffer) => log.debug("worker(stdout): " + chunk.toString("utf8").trim()));

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      // Keep the tail for error reporting; a model download or a torch warning is noisy but is
      // exactly what you want to see when the worker fails.
      stderrTail = (stderrTail + text).slice(-4000);

      for(const line of text.split("\n").filter(Boolean)) {
        log.debug("worker: " + line);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if(code !== 0) {
        reject(new Error("Worker exited with code " + code + ":\n" + stderrTail));

        return;
      }

      try {
        resolvePromise(JSON.parse(readFileSync(outPath, "utf8")) as WorkerResult);
      } catch(error) {
        reject(new Error("Worker produced no readable result: " + (error as Error).message +
          "\nstderr tail:\n" + stderrTail));
      }
    });
  });
}
