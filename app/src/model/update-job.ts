import type { Job } from "../../../src/api/read-model/types";

/** A service update stays running through its Restart step, so the disconnect it causes is expected. */
export function restartingUpdate(job: Job): boolean {
  return job.kind === "update.apply" && job.state === "running" && job.steps.some(step => step.name === "Restart" && step.state === "running");
}
