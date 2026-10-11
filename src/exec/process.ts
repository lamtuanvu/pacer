export interface ExecSpec {
  argv: string[];
  cwd: string;
  stdin?: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  logFile?: string;
  onSpawn?: (pid: number) => void;
}

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

function spawn(spec: ExecSpec) {
  return Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    stdin: spec.stdin !== undefined ? new Blob([spec.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function startReading(stream: ReadableStream<Uint8Array>): {
  promise: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const promise = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      acc += decoder.decode();
    } catch {
      // cancelled or errored — return whatever was collected
    }
    return acc;
  })();
  return {
    promise,
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

/** Run a command to completion. Never throws: a spawn failure is exit code 127. */
export async function execProcess(spec: ExecSpec): Promise<ExecResult> {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(spec);
  } catch (e) {
    const r = { code: 127, stdout: "", stderr: String(e), timedOut: false };
    if (spec.logFile) {
      try {
        await Bun.write(spec.logFile, `$ ${spec.argv.join(" ")}\n--- spawn error\n${r.stderr}\n`);
      } catch {
        // ignore write errors
      }
    }
    return r;
  }

  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onGrace: (() => void) | undefined;
  const graceElapsed = new Promise<void>((resolve) => {
    onGrace = resolve;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    graceTimer = setTimeout(() => onGrace?.(), 2000);
  }, spec.timeoutMs);

  try {
    spec.onSpawn?.(proc.pid);
  } catch {
    // ignore onSpawn errors — timer is already armed
  }

  const out = startReading(proc.stdout);
  const err = startReading(proc.stderr);

  const completion = Promise.all([out.promise, err.promise, proc.exited]).then(
    ([stdout, stderr, code]) => ({ stdout, stderr, code }),
  );

  const winner = await Promise.race([
    completion.then((r) => ({ kind: "done" as const, ...r })),
    graceElapsed.then(() => ({ kind: "grace" as const })),
  ]);

  clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);

  let stdout: string;
  let stderr: string;
  let code: number;

  if (winner.kind === "done") {
    stdout = winner.stdout;
    stderr = winner.stderr;
    code = winner.code;
  } else {
    out.cancel();
    err.cancel();
    stdout = await out.promise;
    stderr = await err.promise;
    code = proc.exitCode ?? 1;
  }

  if (spec.logFile) {
    try {
      await Bun.write(
        spec.logFile,
        `$ ${spec.argv.join(" ")}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n--- exit ${code}${timedOut ? " (timed out)" : ""}\n`,
      );
    } catch {
      // ignore write errors
    }
  }
  return { code, stdout, stderr, timedOut };
}
