/** Mutable stdin boundary so CLI hooks can be exercised without process input. */
export const STDIN_TIMEOUT_MS = 1000;

/** Hook input is optional: a planner closes stdin promptly, so an open stdin with no data (a pipe nobody writes) yields "". */
async function readStdinBounded(ms = STDIN_TIMEOUT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const io = { readStdin: (): Promise<string> => readStdinBounded() };
