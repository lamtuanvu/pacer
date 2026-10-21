import { beginWorkSync, attachRunEvidenceSync, finishWorkSync, reconcileAdmissionSync } from "../update/desktop/admission";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { type RunIO, Unreachable } from "../supervisor/io";
import type { RunState } from "../supervisor/run";
import { WRAPPER_SH } from "../supervisor/wrapper";
import type { Ctx, RunResult } from "../types";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { RemoteViewer } from "./viewer";
import { RemoteRecording } from "./recording";
import { RemoteSession } from "./session";
import { ensureRemoteBinary } from "./runtime";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";

const fields = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => {
  const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
}));
const number = (s: string | undefined): number | null => s?.trim() && Number.isFinite(Number(s)) ? Number(s) : null;
const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

export function ptyWrapper(wrapper: string): string {
  const converted = wrapper.replace(/^if \[ -f .* & fi$/m, '\"$@\" > /dev/null 2> \"$D/stderr\" &');
  if (converted === wrapper) throw new Error("PTY wrapper replacement failed");
  return converted;
}

/** SSH access to a detached wrapper, with a local file record for existing log readers. */
export class RemoteRunIO implements RunIO {
  private session?: RemoteSession;
  private sessionFiles: Record<string,string> = {};
  private recording?: RemoteRecording;
  private viewer?: RemoteViewer;
  private queue: Promise<unknown> = Promise.resolve();
  private serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  };
  constructor(private ctx: Ctx, private host: HostCfg, private remoteDir: string, private localDir: string, private runtime: {binary?:string} = {}) {}

  private async run(script: string, args: string[], stdin?: string): Promise<RunResult> {
    const result = await runRemote(this.ctx, this.host, script, args, { stdin });
    if (result.code === 255) throw new Unreachable(`host ${this.host.alias} unreachable`);
    if (result.code !== 0) throw new Error(result.stderr || `remote command exited ${result.code}`);
    return result;
  }

  async start(argv: string[], cwd: string, env: Record<string, string>, stdin: string, options: { session?: "pty" | "pipe"; capBytes?: number } = {}): Promise<{ pid: number } | { error: string }> {
    let lease: string | undefined, sent = false;
    try {
      for (const key of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment key ${key}`);
      let execution;
      try { execution = validateExecution(loadStrategy(this.ctx).execution); } catch { /* absent strategy keeps pipe default */ }
      const full = this.host.session === "full";
      const mode = options.session ?? execution?.session ?? "pipe";
      const wrapper = mode === "pty" ? ptyWrapper(WRAPPER_SH) : WRAPPER_SH;
      lease = beginWorkSync(this.ctx, { kind: "session", id: createHash("sha256").update(`${this.host.alias}:${this.remoteDir}`).digest("hex"), label: `Remote session on ${this.host.alias}` });
      attachRunEvidenceSync(this.ctx, lease, this.localDir, { host: this.host.alias, dir: this.remoteDir });
      mkdirSync(this.localDir, { recursive: true });
      writeFileSync(join(this.localDir, "admission.json"), JSON.stringify({ lease, host: this.host.alias, remoteDir: this.remoteDir }), { mode: 0o600 });
      if (full) sent = true; // Binary staging can also outlive a lost SSH response.
      const binary = full ? await ensureRemoteBinary(this.ctx,this.host,this.runtime) : undefined;
      const launch = full ? JSON.stringify({argv,cwd,completionNonce:lease,capBytes: options.capBytes ?? (execution?.sessionLogMb ?? 8)*1024*1024})+"\n" : wrapper;
      sent = true;
      const launchEnv = { ...env, PACER_COMPLETION_NONCE: lease };
      const result = await this.run(SCRIPTS.START, [this.remoteDir, cwd, full ? "full" : mode, ...(binary ? [binary] : []), ...Object.entries(launchEnv).map(([key, value]) => `${key}=${value}`), "--", ...argv], `${launch}__PACER_STDIN__\n${stdin}`);
      const started = fields(result.stdout);
      if (started.error) return { error: `remote start refused: ${started.error}` };
      const pid = number(started.pid);
      if (pid === null) return { error: "remote start did not return a pid" };
      mkdirSync(this.localDir, { recursive: true });
      for (const file of ["pid", "started", "exit", "stdout", "stderr", "session.log", "session.log.1", "session.ckpt", "session.json", "session.remote.json", "session.remote-full"]) rmSync(join(this.localDir, file), { force: true });
      writeFileSync(join(this.localDir, "pid"), String(pid));
      if (full) writeFileSync(join(this.localDir,"session.remote-full"),this.host.alias,{mode:0o600});
      if (mode === "pty") writeFileSync(join(this.localDir,"session.json"), JSON.stringify({capBytes: options.capBytes ?? (execution?.sessionLogMb ?? 8)*1024*1024}), {mode:0o600});
      return { pid };
    } catch (e) { if (lease && !sent) finishWorkSync(this.ctx, lease); return { error: e instanceof Error ? e.message : String(e) }; }
  }

  async read(): Promise<RunState> {
    let report: Record<string, string>;
    // Any failed observation (lost connection or a failing remote command) is retried by supervise until its grace ends.
    try { report = fields((await this.run(SCRIPTS.REPORT, [this.remoteDir])).stdout); }
    catch (e) { throw e instanceof Unreachable ? e : new Unreachable(`host ${this.host.alias}: ${e instanceof Error ? e.message : String(e)}`); }
    mkdirSync(this.localDir, { recursive: true });
    let pending = false;
    const full = report.session === "builtin";
    if (full) {
      let files:Record<string,string>;
      try {files=fields((await this.run(SCRIPTS.SESSION_FILES,[this.remoteDir,String(size(join(this.localDir,"session.log"))),this.sessionFiles["session.log.inode"]??"",this.sessionFiles["session.ckpt.sum"]??"",this.sessionFiles["session.log.1.sum"]??""])).stdout);}
      catch(e){throw e instanceof Unreachable ? e : new Unreachable(`host ${this.host.alias}: session recording unavailable`);}
      for (const name of ["session.ckpt","session.log.1","session.log","session.state"]) {
        if (!(name in files)) continue;
        if (!files[`${name}.sum`]) {rmSync(join(this.localDir,name),{force:true});continue;}
        if (name === "session.log" && Number(files["session.log.offset"]) > 0) {
          if(files[name]) appendFileSync(join(this.localDir,name),Buffer.from(files[name],"hex"));
        } else {
          writeFileSync(join(this.localDir,`${name}.tmp`),Buffer.from(files[name],"hex"),{mode:0o600});
          renameSync(join(this.localDir,`${name}.tmp`),join(this.localDir,name));
        }
      }
      this.sessionFiles=files;
      writeFileSync(join(this.localDir,"session.remote-full"),this.host.alias,{mode:0o600});
      if(number(report.exit)===null) {
        this.session ??= new RemoteSession(this.ctx,this.host,this.remoteDir,this.localDir);
        try {await this.session.listen();} catch { /* transport failure does not stop the agent */ }
      } else {await this.session?.close();this.session=undefined;}
    }
    const pty = report.session === "pty" || report.session === "script";
    if (pty) {
      this.recording ??= new RemoteRecording(this.ctx, this.localDir);
      await this.recording.ready;
      if (number(report.exit) === null) {
        this.viewer ??= new RemoteViewer(this.ctx, this.host, this.remoteDir, this.recording, this.serial);
        try { await this.viewer.listen(); } catch { /* viewing is optional */ }
      }
      const total = number(report.raw) ?? 0;
      if (number(report.exit) !== null) await this.viewer?.stopStream();
      await this.serial(async () => {
        const recording = this.recording!;
        let budget = 4*1024*1024;
        while (!this.viewer?.active && total > recording.offset && budget > 0) {
          const chunk = await this.run(SCRIPTS.READ_FROM, [this.remoteDir,"session.raw",String(recording.offset),String(Math.min(262144,budget)),"hex"]);
          const raw = Buffer.from(chunk.stdout,"hex");
          if (!raw.length) break;
          budget -= raw.length;
          const bytes = await recording.output(raw);
          this.viewer?.send(bytes);
        }
        if (number(report.exit) === null) this.viewer?.resume();
        pending = recording.offset < total;
        if (!pending && number(report.exit) !== null) {
          const tail = await recording.close();
          this.viewer?.send(tail);
        }
      });
      if (!pending && number(report.exit) !== null) await this.viewer?.close(number(report.exit)!);
    }
    for (const [stream, key] of [["stdout", "out"], ["stderr", "err"]] as const) {
      if (pty && stream === "stdout") continue;
      const file = join(this.localDir, stream), total = number(report[key]) ?? 0;
      let budget = 4*1024*1024;
      while (total > size(file) && budget > 0) {
        const chunk = await this.run(SCRIPTS.READ_FROM, [this.remoteDir, stream, String(size(file)), String(Math.min(262144,budget)), "hex"]);
        const bytes = Buffer.from(chunk.stdout,"hex");
        if (!bytes.length) break;
        appendFileSync(file, bytes);
        budget -= bytes.length;
      }
      if (size(file) < total) pending = true;
    }
    const pid = number(report.pid), startedAt = number(report.started), exit = number(report.exit);
    for (const [file, value] of [["pid", pid], ["started", startedAt], ["exit", pending ? null : exit]] as const) {
      if (value !== null) writeFileSync(join(this.localDir, file), String(value));
      else rmSync(join(this.localDir, file), { force: true });
    }
    if (!pending && exit !== null && report.admission_complete) {
      // A host-bound nonce receipt proves the exact detached launch completed.
      // Generic exit files, missing PIDs and synthetic STOP exits never do.
      try {
        const binding = JSON.parse(readFileSync(join(this.localDir, "admission.json"), "utf8"));
        if (binding.host === this.host.alias && binding.remoteDir === this.remoteDir && binding.lease === report.admission_complete) {
          writeFileSync(join(this.localDir, "admission.complete"), binding.lease + "\n", { mode: 0o600 });
          reconcileAdmissionSync(this.ctx);
        }
      } catch { /* Missing/malformed binding remains unresolved. */ }
    }
    const times = [Number(pty ? report.raw : report.out) ? number(pty ? report.rawm : report.outm) : null, Number(report.err) ? number(report.errm) : null].filter((t): t is number => t !== null);
    return {
      pid, startedAt, exit: pending ? null : exit, alive: pending || (exit === null && report.alive === "1"),
      stdoutBytes: pty ? size(join(this.localDir,"stdout")) : number(report.out) ?? 0, stderrBytes: number(report.err) ?? 0,
      lastOutputAt: times.length ? Math.max(...times) : null,
    };
  }

  async stop(o: { graceMs: number; sleep: (ms: number) => Promise<void> }): Promise<{ code: number; killed: boolean }> {
    let result: Record<string, string>;
    await this.session?.close();this.session=undefined;
    // An unreachable host cannot be stopped now; the attempt ends and `pacer host clean` removes the run later.
    try { result = fields((await this.run(SCRIPTS.STOP, [this.remoteDir, String(Math.ceil(o.graceMs / 1000))])).stdout); }
    catch (e) {
      await this.viewer?.close(137);
      if (e instanceof Unreachable) return { code: 137, killed: false };
      throw e;
    }
    if (this.recording) {
      await this.viewer?.stopStream();
      try {
        // stop has ended the writer; drain its bounded chunks before collecting stdout.
        for (;;) {
          const state = await this.read();
          if (state.exit !== null || !state.alive) break;
        }
      } catch { /* preserve the already mirrored record on a lost host */ }
      await this.recording.close();
      await this.viewer?.close(number(result.code) ?? 137);
    }
    return { code: number(result.code) ?? 137, killed: result.killed === "1" };
  }
}
