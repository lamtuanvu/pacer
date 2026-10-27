import { z } from "zod";
import { HOST_RUNNER_METHODS, hostRunnerAlias, hostRunnerSession } from "./host-runner-protocol";

/** Caller-visible host broker methods. A caller cannot supply an SSH target or provider. */
export const HOSTS_METHODS = {
  "capability.hosts.prepareOwned": {
    description: "Consume one host-issued persisted remote placement and return its verified worktree.",
    params: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      attempt: z.number().int().positive().safe() }).strict(),
    result: z.object({ worktree: z.string().min(1).max(4096),
      branch: z.string().min(1).max(256) }).strict(),
    deadlineMs: 120_000,
  },
  "capability.hosts.claimOwned": {
    description: "Publish one provider-owned remote run after verified placement and before START.",
    params: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      attempt: z.number().int().positive().safe() }).strict(),
    result: z.object({ dir: z.string().min(1).max(4096), worktree: z.string().min(1).max(4096),
      remoteDir: z.string().min(1).max(4096), branch: z.string().min(1).max(256),
      startedAt: z.number().finite(), logFile: z.string().min(1).max(4096) }).strict(),
    deadlineMs: 15_000,
  },
  "capability.hosts.startOwned": {
    description: "Start the exact persisted remote run once using host-private input and a verified receipt.",
    params: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      attempt: z.number().int().positive().safe() }).strict(),
    result: z.object({ pid: z.number().int().positive().safe() }).strict(),
    deadlineMs: 120_000,
  },
  "capability.hosts.pollOwned": {
    description: "Observe one persisted remote run through fixed bounded SSH reads.",
    params: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      attempt: z.number().int().positive().safe() }).strict(),
    result: z.object({ state: z.enum(["running", "exited", "uncertain"]),
      exitCode: z.number().int().safe().nullable() }).strict(),
    deadlineMs: 120_000,
  },
  "capability.hosts.readOwnedOutput": {
    description: "Return bounded output tails after host-verified remote exit.",
    params: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      attempt: z.number().int().positive().safe() }).strict(),
    result: z.object({ stdoutBase64: z.string().max(349_528),
      stderrBase64: z.string().max(349_528) }).strict(),
    deadlineMs: 15_000,
  },
  "capability.hosts.open": {
    description: "Open an owner-bound broker session for a configured host alias.",
    params: z.object({ alias: hostRunnerAlias }).strict(),
    result: z.object({ session: hostRunnerSession }).strict(),
    deadlineMs: 30_000,
  },
  "capability.hosts.run": {
    description: "Run one fixed script through an owned broker session with bounded text output.",
    params: HOST_RUNNER_METHODS["hostRunner.run"].params.omit({ completionNonce: true }),
    result: HOST_RUNNER_METHODS["hostRunner.run"].result,
    deadlineMs: 120_000,
  },
  "capability.hosts.fetch": {
    description: "Claim one host-issued bundle stage in an owned broker session without returning a path or handle.",
    params: z.object({ session: hostRunnerSession, timeoutMs: z.number().int().positive().max(60_000),
      maxBytes: z.number().int().positive().max(50 * 1024 * 1024) }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    deadlineMs: 120_000,
  },
  "capability.hosts.close": {
    description: "Close an owned broker session.",
    params: z.object({ session: hostRunnerSession }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    deadlineMs: 10_000,
  },
} as const;

export const HOSTS_METHOD_CAPABILITY = {
  "capability.hosts.prepareOwned": "hosts",
  "capability.hosts.claimOwned": "hosts",
  "capability.hosts.startOwned": "hosts",
  "capability.hosts.pollOwned": "hosts",
  "capability.hosts.readOwnedOutput": "hosts",
  "capability.hosts.open": "hosts",
  "capability.hosts.run": "hosts",
  "capability.hosts.fetch": "hosts",
  "capability.hosts.close": "hosts",
} as const;
