import { closeSync, openSync, writeSync } from "node:fs";
/** Executor accounts must not inherit the planner's selected account. */
export function executorEnv(base: Record<string, string | undefined>, account: Record<string, string>, taskId?: string): Record<string, string | undefined> {
  const env = {...base};
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.PACER_RUN_DIR;
  delete env.PACER_REPORT_TOKEN;
  delete env.PACER_TRANSCRIPT_REPORT;
  return {...env, ...account, PACER_ROLE: "executor", PACER_TASK_ID: taskId};
}

export interface ExecSpec {
  argv: string[];
  cwd: string;
  stdin?: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  logFile?: string;
  /** Raw stdout destination, without text decoding or accumulation. */
  stdoutFile?: string;
  maxStdoutBytes?: number;
  onSpawn?: (pid: number) => void;
}

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; stdoutOverflow?: boolean }

/** Signal the executor's process group, falling back to the direct child. Never throws. */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

function spawn(spec: ExecSpec) {
  return Bun.spawn(spec.argv, {
    detached: true,
    cwd: spec.cwd,
    // Tools that resolve paths from $PWD (OpenCode does) must see the child's
    // directory, not the parent's.
    env: { ...(spec.env ?? process.env), PWD: spec.cwd },
    stdin: spec.stdin !== undefined ? new Blob([spec.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function startReading(stream: ReadableStream<Uint8Array>, onChunk?: (value: Uint8Array) => void): {
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
        if (onChunk) onChunk(value);
        else acc += decoder.decode(value, { stream: true });
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
  let stdoutFd: number | undefined;
  try {
    if (spec.stdoutFile) stdoutFd = openSync(spec.stdoutFile, "w", 0o600);
    proc = spawn(spec);
  } catch (e) {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
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
    killTree(proc.pid, "SIGKILL");
    graceTimer = setTimeout(() => onGrace?.(), 2000);
  }, spec.timeoutMs);

  try {
    spec.onSpawn?.(proc.pid);
  } catch {
    // ignore onSpawn errors — timer is already armed
  }

  let stdoutBytes = 0, stdoutOverflow = false, stdoutError = "";
  const chunks: Uint8Array[] = [];
  const out = startReading(proc.stdout, spec.stdoutFile || spec.maxStdoutBytes !== undefined ? (value) => {
    if (stdoutOverflow || stdoutError) return;
    stdoutBytes += value.length;
    if (spec.maxStdoutBytes !== undefined && stdoutBytes > spec.maxStdoutBytes) {
      stdoutOverflow = true;
      killTree(proc.pid, "SIGKILL");
      graceTimer = setTimeout(() => onGrace?.(), 2000);
      return;
    }
    try {
      if (stdoutFd !== undefined) {
        let at = 0;
        while (at < value.length) at += writeSync(stdoutFd, value, at, value.length - at);
      } else chunks.push(value);
    } catch (e) {
      stdoutError = String(e);
      killTree(proc.pid, "SIGKILL");
      graceTimer = setTimeout(() => onGrace?.(), 2000);
    }
  } : undefined);
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

  if (stdoutFd !== undefined) closeSync(stdoutFd);
  if (spec.maxStdoutBytes !== undefined && !spec.stdoutFile) stdout = Buffer.concat(chunks).toString("utf8");
  if (stdoutOverflow || stdoutError) { code = code || 1; stderr += stdoutError; }

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
  return { code, stdout, stderr, timedOut, ...(stdoutOverflow ? { stdoutOverflow: true } : {}) };
}
