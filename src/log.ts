const LEVELS = { debug: 10, error: 40, info: 20, warn: 30 } as const;

type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) in LEVELS ? process.env.LOG_LEVEL as Level : "info"];

function emit(level: Level, message: string): void {
  if(LEVELS[level] < threshold) {
    return;
  }

  const line = new Date().toISOString() + " " + level.toUpperCase().padEnd(5) + " " + message;

  // Everything goes to stderr so a command's actual output on stdout stays pipeable.
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (m: string) => emit("debug", m),
  error: (m: string) => emit("error", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m)
};
