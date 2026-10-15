import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { shq } from "../install/fsx";
import type { Ctx, RunResult } from "../types";
import { killTree } from "../exec/process";
import { SCRIPTS } from "./scripts";

/** Private directory for pacer's own OpenSSH multiplexing sockets. */
export function controlDir(ctx: Ctx): string {
  const dir = join(ctx.pacerHome, "ssh");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function sshArgv(ctx: Ctx, host: HostCfg, script: string, args: string[]): string[] {
  if (!Object.values<string>(SCRIPTS).includes(script)) throw new Error("unknown remote script");
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(ctx), "cm-%C")}`,
    "-o", "ControlPersist=60", "--", host.ssh,
    `bash -lc ${shq(`printf '__PACER_BEGIN__\\n'; ${script}`)} pacer${args.map((arg) => ` ${shq(arg)}`).join("")}`,
  ];
}

export async function runRemote(ctx: Ctx, host: HostCfg, script: string, args: string[], o: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const result = await ctx.run(sshArgv(ctx, host, script, args), o.timeoutMs ?? 60_000, { stdin: o.stdin });
  return { ...result, stdout: payload(result.stdout) };
}

const SENTINEL = "__PACER_BEGIN__\n";

/** Only the fixed script's framed output is a protocol payload. */
export function payload(stdout: string): string {
  const at = stdout.search(/^__PACER_BEGIN__\n/m);
  return at >= 0 ? stdout.slice(at + SENTINEL.length) : "";
}

/** Discard login-shell chatter without decoding any bundle bytes or retaining it. */
export async function* payloadStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const marker = Buffer.from(SENTINEL);
  let prefix = Buffer.alloc(0), framed = false, lineStart = true;
  for await (const chunk of stream) {
    if (framed) { yield chunk; continue; }
    const bytes = Buffer.concat([prefix, chunk]);
    prefix = Buffer.alloc(0);
    for (let i = 0; i < bytes.length; i++) {
      if (lineStart && bytes[i] === marker[0]) {
        const remaining = bytes.subarray(i);
        if (remaining.length < marker.length && marker.subarray(0, remaining.length).equals(remaining)) {
          prefix = remaining; break;
        }
        if (remaining.subarray(0, marker.length).equals(marker)) {
          framed = true;
          yield remaining.subarray(marker.length);
          break;
        }
      }
      lineStart = bytes[i] === 10;
    }
  }
  if (!framed) throw new Error("remote payload sentinel missing");
}

export async function bundleToFile(ctx: Ctx, host: HostCfg, args: string[], path: string, maxBytes: number): Promise<RunResult & { stdoutOverflow?: boolean }> {
  const fd = openSync(path, "w", 0o600);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(sshArgv(ctx, host, SCRIPTS.BUNDLE_OUT, args), { env: ctx.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) { closeSync(fd); throw e; }
  const error = new Response(proc.stderr).text();
  const timer = setTimeout(() => killTree(proc.pid, "SIGKILL"), 60000);
  let size = 0, overflow = false;
  try {
    for await (const bytes of payloadStream(proc.stdout)) {
      size += bytes.length;
      if (size > maxBytes) { overflow = true; killTree(proc.pid, "SIGKILL"); break; }
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    }
    const [code, stderr] = await Promise.all([proc.exited, error]);
    return { code, stderr, stdout: "", ...(overflow ? { stdoutOverflow: true } : {}) };
  } finally { clearTimeout(timer); closeSync(fd); if (proc.exitCode === null) killTree(proc.pid, "SIGKILL"); }
}
