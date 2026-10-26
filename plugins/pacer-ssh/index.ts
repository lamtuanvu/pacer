#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { PluginError, serve, type Handler } from "@pacer/plugin";
import { manifest } from "./manifest";
import { bundleOutArgv, checkHomeArgv, checkRepoArgv, cleanArgv, cloneRepoArgv, preflightArgv, prepareArgv, probeArgv, probePayload, questionArgv, readFromArgv, reportArgv, setIdentityArgv, stopArgv, usageArgv } from "./probe";

export { manifest } from "./manifest";

interface Session { sshTarget: string; controlPath: string }
const sessions = new Map<string, Session>();
const fail = (code: string, message: string): never => { throw new PluginError(code, message); };
const validTarget = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/.test(value);
const validSession = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const validControlPath = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 512 && /^\/[^\u0000-\u001f]*\/cm-%C$/.test(value);

type SpawnResult = { code: number; stdout: string; stderr: string; timedOut: boolean } |
  { code: number; output: { stdout: string; stderr: string }; timedOut: boolean };

export const handlers: Record<string, Handler> = {
  "hostRunner.check": async (raw, host, signal) => {
    const input = raw as Record<string, unknown>;
    if (signal.aborted || typeof input?.alias !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(input.alias) ||
      !validTarget(input.sshTarget) || !validControlPath(input.controlPath) ||
      (input.repo !== undefined && (typeof input.repo !== "string" || !input.repo.trim() || input.repo.includes("\0"))) ||
      (input.home !== undefined && (typeof input.home !== "string" || !input.home.trim() || input.home.includes("\0"))) ||
      (input.repo !== undefined && input.home !== undefined))
      fail("capability_denied", "host check has no issued SSH snapshot");
    const repo = input.repo as string | undefined, sshTarget = input.sshTarget as string,
      home = input.home as string | undefined, controlPath = input.controlPath as string;
    const result = await host.call<SpawnResult>("capability.process.spawn", {
      argv: home !== undefined ? checkHomeArgv(sshTarget, controlPath, home) :
        repo !== undefined ? checkRepoArgv(sshTarget, controlPath, repo) :
          probeArgv(sshTarget, controlPath), timeoutMs: 50_000,
    });
    if (signal.aborted) fail("capability_denied", "SSH check cancelled");
    if ("output" in result) fail("too_large", "SSH check output exceeds the inline bound");
    const inline = result as Extract<SpawnResult, { stdout: string }>;
    if (result.code === 255) fail("plugin_unavailable", "SSH check connection failed");
    let stdout: string;
    try { stdout = probePayload(inline.stdout); }
    catch { fail("plugin_refused", "SSH check returned no payload frame"); }
    if (Buffer.byteLength(stdout!) + Buffer.byteLength(inline.stderr) > 65_536)
      fail("too_large", "SSH check output exceeds the issued bound");
    const facts = Object.fromEntries(stdout!.split("\n").filter(line => line.includes("=")).map(line =>
      [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (home !== undefined) {
      const ok = result.code === 0 && !result.timedOut;
      return { ok, checks: [{ name: "account home", ok, detail: ok ? "" : "missing account home" }] };
    }
    if (repo === undefined) {
      const ok = result.code === 0 && !result.timedOut;
      return { ok, checks: [{ name: "ssh", ok, detail: ok ? "" : "unreachable" }],
        facts: Object.fromEntries(Object.entries(facts).filter(([key, value]) =>
          ["os", "arch", "glibc", "git", "setsid", "script", "tail", "codex", "claude"].includes(key) && value.length <= 256)) };
    }
    const completed = result.code === 0 && !result.timedOut;
    const ok = completed && facts.exists === "1" && facts.git === "1";
    return { ok, checks: [{ name: "checkout", ok, detail: ok ? "" : "checkout unavailable" }],
      facts: completed ? Object.fromEntries(Object.entries(facts).filter(([key, value]) =>
        ["exists", "git", "origin", "name", "email"].includes(key) && value.length <= 256)) : {} };
  },
  "hostRunner.open": async (raw, _host, signal) => {
    const input = raw as Record<string, unknown>;
    const target = input?.sshTarget, path = input?.controlPath;
    if (signal.aborted || !validTarget(target) ||
      typeof path !== "string" || path.length > 512 || !/^\/[^\u0000-\u001f]*\/cm-%C$/.test(path))
      fail("invalid_input", "invalid host-issued SSH snapshot");
    const session = randomUUID().replaceAll("-", "");
    sessions.set(session, { sshTarget: target as string, controlPath: path as string });
    return { session };
  },
  "hostRunner.run": async (raw, host, signal) => {
    const input = raw as Record<string, unknown>;
    const args = input?.args;
    const probe = input?.script === "PROBE" && Array.isArray(args) && args.length === 0;
    const repoCheck = input?.script === "CHECK_REPO" && Array.isArray(args) && args.length === 2 &&
      typeof args[0] === "string" && args[0].length > 0 && !args[0].includes("\0") &&
      args[1] === "check";
    const preflight = input?.script === "PREFLIGHT" && Array.isArray(args) && [3, 5].includes(args.length);
    const identity = input?.script === "SET_IDENTITY" && Array.isArray(args) && args.length === 3 &&
      typeof input.completionNonce === "string";
    const clone = input?.script === "CHECK_REPO" && Array.isArray(args) && args.length === 3 &&
      args[1] === "clone" && typeof input.completionNonce === "string";
    const clean = input?.script === "CLEAN" && Array.isArray(args) && args.length === 5 &&
      typeof input.completionNonce === "string";
    const prepare = input?.script === "PREPARE" && Array.isArray(args) && args.length === 6 &&
      typeof input.completionNonce === "string";
    const report = input?.script === "REPORT" && Array.isArray(args) && args.length === 1;
    const readFrom = input?.script === "READ_FROM" && Array.isArray(args) && args.length === 5;
    const stop = input?.script === "STOP" && Array.isArray(args) && args.length === 2 &&
      typeof input.completionNonce === "string";
    const question = input?.script === "QUESTION" && Array.isArray(args) && args.length === 1;
    const usage = input?.script === "CODEX_USAGE" && Array.isArray(args) && args.length <= 1;
    if (!validSession(input?.session) || (!probe && !repoCheck && !preflight && !identity && !clone && !clean && !stop && !prepare && !report && !readFrom && !question && !usage) ||
      (identity || clone || clean || stop || prepare ? !/^[a-f0-9-]{36}$/.test(input.completionNonce as string) : input.completionNonce !== undefined) ||
      input.stdin !== undefined || !Number.isSafeInteger(input.timeoutMs) ||
      (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 120_000 ||
      !Number.isSafeInteger(input.maxBytes) || (input.maxBytes as number) < 1 ||
      (input.maxBytes as number) > (readFrom ? 524_288 : 65_536))
      fail("capability_denied", "host operation is not issued for this provider");
    const session = sessions.get(input.session as string) ?? fail("capability_denied", "unknown provider SSH session");
    if (signal.aborted) fail("capability_denied", "SSH operation cancelled");
    let argv: string[];
    try {
      argv = probe ? probeArgv(session.sshTarget, session.controlPath) : usage ?
        usageArgv(session.sshTarget, session.controlPath, args as string[]) : question ?
        questionArgv(session.sshTarget, session.controlPath, args as string[]) : preflight ?
        preflightArgv(session.sshTarget, session.controlPath, args as string[]) : identity ?
        setIdentityArgv(session.sshTarget, session.controlPath, args as string[], input.completionNonce as string) : stop ?
        stopArgv(session.sshTarget, session.controlPath, args as string[], input.completionNonce as string) : prepare ?
        prepareArgv(session.sshTarget, session.controlPath, args as string[], input.completionNonce as string) : report ?
        reportArgv(session.sshTarget, session.controlPath, args as string[]) : readFrom ?
        readFromArgv(session.sshTarget, session.controlPath, args as string[]) : clean ?
        cleanArgv(session.sshTarget, session.controlPath, args as string[], input.completionNonce as string) : clone ?
        cloneRepoArgv(session.sshTarget, session.controlPath, args as string[], input.completionNonce as string) :
        checkRepoArgv(session.sshTarget, session.controlPath, (args as string[])[0]!);
    } catch { fail("capability_denied", "invalid host-issued operation"); }
    const result = await host.call<SpawnResult>("capability.process.spawn", {
      argv: argv!, timeoutMs: input.timeoutMs,
    });
    if (signal.aborted) fail("capability_denied", "SSH operation cancelled");
    if ("output" in result) fail("too_large", "SSH probe output exceeds the inline bound");
    const inline = result as Extract<SpawnResult, { stdout: string }>;
    if (result.code === 255) fail("plugin_unavailable", "SSH probe connection failed");
    if (result.timedOut) return { code: result.code, stdout: "", stderr: inline.stderr, timedOut: true };
    let stdout: string;
    try { stdout = probePayload(inline.stdout); }
    catch { fail("plugin_refused", "SSH probe returned no payload frame"); }
    if (Buffer.byteLength(stdout!) + Buffer.byteLength(inline.stderr) > (input.maxBytes as number))
      fail("too_large", "SSH probe output exceeds the issued bound");
    return { code: result.code, stdout: stdout!, stderr: inline.stderr, timedOut: false };
  },
  "hostRunner.fetch": async (raw, host, signal) => {
    const input = raw as Record<string, unknown>;
    if (!validSession(input?.session) || input.script !== "BUNDLE_OUT" ||
      !Array.isArray(input.args) || input.args.length !== 3 || input.stdin !== undefined ||
      !Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 60_000 ||
      !Number.isSafeInteger(input.maxBytes) || (input.maxBytes as number) < 1 ||
      (input.maxBytes as number) > 50 * 1024 * 1024)
      fail("capability_denied", "bundle fetch is not issued for this provider");
    const session = sessions.get(input.session as string) ?? fail("capability_denied", "unknown provider SSH session");
    if (signal.aborted) fail("capability_denied", "SSH bundle fetch cancelled");
    let argv: string[];
    try { argv = bundleOutArgv(session.sshTarget, session.controlPath, input.args as string[]); }
    catch { fail("capability_denied", "invalid host-issued bundle tuple"); }
    const result = await host.call<{ handle: string; bytes: number; sha256: string }>("capability.process.stageBundle",
      { argv: argv!, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes });
    if (signal.aborted) fail("capability_denied", "SSH bundle fetch cancelled");
    if (!result || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.handle) ||
      !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > (input.maxBytes as number) ||
      !/^[a-f0-9]{64}$/.test(result.sha256))
      fail("plugin_refused", "bundle stage returned invalid metadata");
    return { handle: result.handle, bytes: result.bytes, sha256: result.sha256 };
  },
  "hostRunner.close": async raw => {
    const input = raw as Record<string, unknown>;
    if (!validSession(input?.session) || !sessions.delete(input.session)) fail("capability_denied", "unknown provider SSH session");
    return { ok: true };
  },
};

if (import.meta.main) await serve({ manifest, handlers });
