import { z } from "zod";
import { HOST_RUNNER_METHODS, hostRunnerAlias } from "./host-runner-protocol";

const identityText = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));

/** Host-issued caller input. The broker still checks every byte against its one-use grant. */
export const REMOTE_CALLER_METHODS = {
  "remoteCaller.identity": {
    description: "Apply one configured repository identity through an owned host session.",
    params: z.object({ alias: hostRunnerAlias, path: z.string().min(1).max(4096),
      name: identityText, email: identityText }).strict(),
    result: HOST_RUNNER_METHODS["hostRunner.run"].result,
    deadlineMs: 60_000,
  },
} as const;
