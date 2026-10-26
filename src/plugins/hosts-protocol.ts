import { z } from "zod";
import { HOST_RUNNER_METHODS, hostRunnerAlias, hostRunnerSession } from "./host-runner-protocol";

/** Caller-visible host broker methods. A caller cannot supply an SSH target or provider. */
export const HOSTS_METHODS = {
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
  "capability.hosts.open": "hosts",
  "capability.hosts.run": "hosts",
  "capability.hosts.fetch": "hosts",
  "capability.hosts.close": "hosts",
} as const;
