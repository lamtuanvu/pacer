import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { type RunIO, Unreachable } from "../supervisor/io";
import type { RunState } from "../supervisor/run";
import { WRAPPER_SH } from "../supervisor/wrapper";
import type { Ctx, RunResult } from "../types";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";

const fields = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => {
  const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
}));
const number = (s: string | undefined): number | null => s?.trim() && Number.isFinite(Number(s)) ? Number(s) : null;
const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

/** SSH access to a detached wrapper, with a local file record for existing log readers. */
export class RemoteRunIO implements RunIO {
  constructor(private ctx: Ctx, private host: HostCfg, private remoteDir: string, private localDir: string) {}

  private async run(script: string, args: string[], stdin?: string): Promise<RunResult> {
    const result = await runRemote(this.ctx, this.host, script, args, { stdin });
    if (result.code === 255) throw new Unreachable(`host ${this.host.alias} unreachable`);
    if (result.code !== 0) throw new Error(result.stderr || `remote command exited ${result.code}`);
    return result;
  }

  async start(argv: string[], cwd: string, env: Record<string, string>, stdin: string): Promise<{ pid: number } | { error: string }> {
    try {
      for (const key of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment key ${key}`);
      const result = await this.run(SCRIPTS.START, [this.remoteDir, cwd, ...Object.entries(env).map(([key, value]) => `${key}=${value}`), "--", ...argv], `${WRAPPER_SH}__PACER_STDIN__\n${stdin}`);
      const pid = number(fields(result.stdout).pid);
      if (pid === null) return { error: "remote start did not return a pid" };
      mkdirSync(this.localDir, { recursive: true });
      for (const file of ["pid", "started", "exit", "stdout", "stderr"]) rmSync(join(this.localDir, file), { force: true });
      writeFileSync(join(this.localDir, "pid"), String(pid));
      return { pid };
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }

  async read(): Promise<RunState> {
    let report: Record<string, string>;
    // Any failed observation (lost connection or a failing remote command) is retried by supervise until its grace ends.
    try { report = fields((await this.run(SCRIPTS.REPORT, [this.remoteDir])).stdout); }
    catch (e) { throw e instanceof Unreachable ? e : new Unreachable(`host ${this.host.alias}: ${e instanceof Error ? e.message : String(e)}`); }
    mkdirSync(this.localDir, { recursive: true });
    let pending = false;
    for (const [stream, key] of [["stdout", "out"], ["stderr", "err"]] as const) {
      const file = join(this.localDir, stream), offset = size(file), total = number(report[key]) ?? 0;
      if (total > offset) {
        const chunk = await this.run(SCRIPTS.READ_FROM, [this.remoteDir, stream, String(offset), "262144", "hex"]);
        appendFileSync(file, Buffer.from(chunk.stdout, "hex"));
      }
      if (size(file) < total) pending = true;
    }
    const pid = number(report.pid), startedAt = number(report.started), exit = number(report.exit);
    for (const [file, value] of [["pid", pid], ["started", startedAt], ["exit", pending ? null : exit]] as const) {
      if (value !== null) writeFileSync(join(this.localDir, file), String(value));
      else rmSync(join(this.localDir, file), { force: true });
    }
    const times = [Number(report.out) ? number(report.outm) : null, Number(report.err) ? number(report.errm) : null].filter((t): t is number => t !== null);
    return {
      pid, startedAt, exit: pending ? null : exit, alive: pending || (exit === null && report.alive === "1"),
      stdoutBytes: number(report.out) ?? 0, stderrBytes: number(report.err) ?? 0,
      lastOutputAt: times.length ? Math.max(...times) : null,
    };
  }

  async stop(o: { graceMs: number; sleep: (ms: number) => Promise<void> }): Promise<{ code: number; killed: boolean }> {
    let result: Record<string, string>;
    // An unreachable host cannot be stopped now; the attempt ends and `pacer host clean` removes the run later.
    try { result = fields((await this.run(SCRIPTS.STOP, [this.remoteDir, String(Math.ceil(o.graceMs / 1000))])).stdout); }
    catch (e) { if (e instanceof Unreachable) return { code: 137, killed: false }; throw e; }
    return { code: number(result.code) ?? 137, killed: result.killed === "1" };
  }
}
