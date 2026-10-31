import { z } from "zod";
import { HOST_RUNNER_METHODS, hostRunnerAlias } from "./host-runner-protocol";

const identityText = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));

/** Host-issued caller input. The broker still checks every byte against its one-use grant. */
export const REMOTE_CALLER_METHODS = {
  "remoteCaller.reachability": {
    description: "Probe one configured SSH host through the broker's fixed read-only script.",
    params: z.object({ alias: hostRunnerAlias }).strict(),
    result: z.object({ reachable: z.boolean() }).strict(),
    deadlineMs: 30_000,
  },
  "remoteCaller.fetch": {
    description: "Receive one host-issued persisted task bundle through an owned host session.",
    params: z.object({ alias: hostRunnerAlias, timeoutMs: z.number().int().positive().max(60_000),
      maxBytes: z.number().int().positive().max(50 * 1024 * 1024) }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    deadlineMs: 120_000,
  },
  "remoteCaller.identity": {
    description: "Apply one configured repository identity through an owned host session.",
    params: z.object({ alias: hostRunnerAlias, path: z.string().min(1).max(4096),
      name: identityText, email: identityText }).strict(),
    result: HOST_RUNNER_METHODS["hostRunner.run"].result,
    deadlineMs: 60_000,
  },
  "remoteCaller.questionRead": {
    description: "Read one question from a persisted remote task run with a host-issued grant.",
    params: z.object({ alias: hostRunnerAlias, path: z.string().min(1).max(4096) }).strict(),
    result: HOST_RUNNER_METHODS["hostRunner.run"].result,
    deadlineMs: 40_000,
  },
  "remoteCaller.usageRead": {
    description: "Read one configured Codex account's remote usage with a one-use host grant.",
    params: z.object({ alias: hostRunnerAlias,
      home: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional() }).strict(),
    result: HOST_RUNNER_METHODS["hostRunner.run"].result,
    deadlineMs: 90_000,
  },
} as const;
