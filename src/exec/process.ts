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

/** Run a command to completion. Never throws: a spawn failure is exit code 127. */
export async function execProcess(spec: ExecSpec): Promise<ExecResult> {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(spec);
  } catch (e) {
    const r = { code: 127, stdout: "", stderr: String(e), timedOut: false };
    if (spec.logFile) await Bun.write(spec.logFile, `$ ${spec.argv.join(" ")}\n--- spawn error\n${r.stderr}\n`);
    return r;
  }
  spec.onSpawn?.(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, spec.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (spec.logFile) {
    await Bun.write(
      spec.logFile,
      `$ ${spec.argv.join(" ")}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n--- exit ${code}${timedOut ? " (timed out)" : ""}\n`,
    );
  }
  return { code, stdout, stderr, timedOut };
}
