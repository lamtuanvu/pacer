import { z } from "zod";

/** Fixed IDs name reviewed scripts; they are never remote shell text. */
export const HOST_RUNNER_SCRIPTS = [
  "CODEX_USAGE", "PROBE", "CHECK_REPO", "SET_IDENTITY",
  "PREPARE", "QUESTION", "PREFLIGHT", "BUNDLE_OUT",
  "CLEAN", "BINARY", "SESSION_FILES", "SESSION_PIPE",
  "START", "REPORT", "READ_FROM", "STOP",
] as const;
export const hostRunnerScript = z.enum(HOST_RUNNER_SCRIPTS);
export const hostRunnerContribution = z.object({ kinds: z.tuple([z.literal("ssh")]) }).strict();
// Match the established host configuration grammar; the JSON-RPC frame limit
// still applies at transport, without silently invalidating existing records.
export const hostRunnerAlias = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
/** Only the host broker may supply this validated snapshot of hosts.<alias>.ssh. */
export const hostRunnerSshTarget = z.string().regex(/^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/);
export const hostRunnerSession = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const hostRunnerStreamId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
/** Provider-only snapshot; the host derives this from its private SSH socket directory. */
const hostRunnerControlPath = z.string().max(512).regex(/^\/[^\u0000-\u001f]*\/cm-%C$/);
const text = z.string().max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "control characters are forbidden");
const configuredRepoPath = z.string().regex(/\S/, "repository path is empty");
const scriptArgs = z.array(text).max(32);
const deadline = z.number().int().positive().max(120_000);
const byteCount = z.number().int().nonnegative().max(50 * 1024 * 1024);
const request = z.object({ session: hostRunnerSession, script: hostRunnerScript, args: scriptArgs, timeoutMs: deadline }).strict();
const exitCode = z.number().int().min(0).max(255);

/** Host runner contract used by the bundled SSH provider and host-issued calls. */
export const HOST_RUNNER_METHODS = {
  "hostRunner.check": { description: "Check a configured SSH host without opening a persistent session.",
    // Additive transport fields: only the host registry may issue these snapshots.
    // `home` selects only the fixed directory-existence arm of CHECK_REPO.
    // Legacy alias/repo params remain schema-valid but the reference provider rejects them.
    params: z.object({ alias: hostRunnerAlias, repo: configuredRepoPath.optional(), home: configuredRepoPath.optional(),
      sshTarget: hostRunnerSshTarget.optional(), controlPath: hostRunnerControlPath.optional() }).strict(),
    result: z.object({ ok: z.boolean(), checks: z.array(z.object({ name: text, ok: z.boolean(), detail: text }).strict()).max(64),
      facts: z.record(z.string().max(64), z.string().max(256)).optional() }).strict(), deadlineMs: 60_000 },
  "hostRunner.open": { description: "Open a host-issued SSH target snapshot and return an opaque provider session.",
    params: z.object({ alias: hostRunnerAlias, sshTarget: hostRunnerSshTarget, controlPath: hostRunnerControlPath.optional() }).strict(),
    result: z.object({ session: hostRunnerSession }).strict(), deadlineMs: 30_000 },
  "hostRunner.run": { description: "Run a fixed script with bounded arguments and text output.",
    params: request.extend({ stdin: z.string().max(65_536).optional(), maxBytes: z.number().int().positive().max(524_288),
      /** Host-only mutation receipt; caller capability schema omits this field. */
      completionNonce: z.string().uuid().optional() }).strict(),
    result: z.object({ code: exitCode, stdout: z.string().max(524_288), stderr: z.string().max(524_288), timedOut: z.boolean() }).strict(), deadlineMs: 120_000 },
  "hostRunner.upload": { description: "Run one host-issued fixed binary upload with private bounded stdin.",
    params: z.object({ session: hostRunnerSession, script: z.literal("BINARY"),
      // A homogeneous bounded array keeps generated Rust wire types constructible;
      // the refinement and fixed provider guard still pin the hash/action pair.
      args: z.array(z.string().max(64)).length(2).refine(args =>
        /^[a-f0-9]{64}$/.test(args[0] ?? "") && args[1] === "upload"),
      timeoutMs: z.number().int().positive().max(300_000), maxBytes: z.number().int().positive().max(4096),
      completionNonce: z.string().uuid() }).strict(),
    result: z.object({ code: exitCode, stdout: z.string().max(4096), stderr: z.string().max(4096), timedOut: z.boolean() }).strict(), deadlineMs: 310_000 },
  "hostRunner.stream": { description: "Stream one host-issued fixed SSH session through acknowledged progress frames.",
    params: request.extend({ maxBytes: z.number().int().positive().max(50 * 1024 * 1024), streamId: hostRunnerStreamId.optional() }).strict(),
    result: z.object({ code: exitCode, bytes: z.number().int().nonnegative().safe() }).strict(), deadlineMs: 120_000 },
  "hostRunner.fetch": { description: "Stage a fixed-script bundle fetch; the host later resolves the safe artifact name.",
    params: request.extend({ maxBytes: z.number().int().positive().max(50 * 1024 * 1024) }).strict(),
    result: z.object({ name: z.string().regex(/^[a-f0-9]{64}\.bundle$/), bytes: byteCount,
      sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), deadlineMs: 120_000 },
  "hostRunner.close": { description: "Close an owned host session.",
    params: z.object({ session: hostRunnerSession }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(), deadlineMs: 10_000 },
} as const;

export type HostRunnerScript = z.infer<typeof hostRunnerScript>;
export type HostRunnerRunInput = z.infer<typeof HOST_RUNNER_METHODS["hostRunner.run"]["params"]>;
