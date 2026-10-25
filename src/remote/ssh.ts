import { beginWorkSync, finishWorkSync } from "../update/desktop/admission";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { shq } from "../install/fsx";
import type { Ctx, RunResult } from "../types";
import { killTree } from "../exec/process";
import { SCRIPTS } from "./scripts";

/** Private directory for pacer's own OpenSSH multiplexing sockets. */
export function controlDir(ctx: Ctx): string {
  const homeDir = join(ctx.pacerHome, "ssh");
  // OpenSSH expands %C to 40 hex bytes; macOS rejects socket paths >= 104 bytes.
  const tooLong = Buffer.byteLength(join(homeDir, `cm-${"f".repeat(40)}`)) >= 104;
  const short = tooLong && process.platform !== "win32";
  const dir = short
    ? join("/tmp", `pacer-ssh-${process.getuid!()}-${createHash("sha256").update(ctx.pacerHome).digest("hex").slice(0, 16)}`)
    : homeDir;
  if (short) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(dir);
    if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0) {
      throw new Error("SSH control directory is not private and owned by this user");
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return dir;
}

export function sshArgv(ctx: Ctx, host: HostCfg, script: string, args: string[], completionNonce?: string): string[] {
  if (!Object.values<string>(SCRIPTS).includes(script)) throw new Error("unknown remote script");
  if (completionNonce && !/^[a-f0-9-]{36}$/.test(completionNonce)) throw new Error("invalid remote completion nonce");
  const program = completionNonce
    ? `printf '__PACER_BEGIN__\\n'; ( ${script}\n); pacer_result=$?; printf '\\n__PACER_DONE__=${completionNonce}\\n'; exit "$pacer_result"`
    : `printf '__PACER_BEGIN__\\n'; ${script}`;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(ctx), "cm-%C")}`,
    "-o", "ControlPersist=60", "--", host.ssh,
    `bash -lc ${shq(program)} pacer${args.map((arg) => ` ${shq(arg)}`).join("")}`,
  ];
}

export async function runRemote(ctx: Ctx, host: HostCfg, script: string, args: string[], o: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const mutation = ([SCRIPTS.PREPARE, SCRIPTS.CLEAN, SCRIPTS.SET_IDENTITY] as readonly string[]).includes(script)
    || (script === SCRIPTS.CHECK_REPO && args[1] === "clone")
    || (script === SCRIPTS.BINARY && args[1] !== "check");
  const lease = mutation ? beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote operation on ${host.alias}` }) : undefined;
  let sent = false;
  try {
    const argv = sshArgv(ctx, host, script, args, lease);
    sent = true;
    const result = await ctx.run(argv, o.timeoutMs ?? 60_000, { stdin: o.stdin });
    let stdout = payload(result.stdout);
    if (lease) {
      const completion = `\n__PACER_DONE__=${lease}\n`;
      if (!result.timedOut && result.code !== 255 && stdout.endsWith(completion)) {
        stdout = stdout.slice(0, -completion.length);
        finishWorkSync(ctx, lease);
      }
      // Private completion capabilities never enter command/API output, even
      // when a transport failure makes an otherwise complete receipt ambiguous.
      stdout = stdout.replaceAll(`__PACER_DONE__=${lease}`, "");
    }
    return { ...result, stdout };
  } catch (error) {
    if (lease && !sent) finishWorkSync(ctx, lease);
    throw error;
  }
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
