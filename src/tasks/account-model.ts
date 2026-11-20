/** The account and model one task row shows: the in-flight attempt while running, the latest attempt otherwise. */
import { parseRunnerId } from "../config/runner-id";
import type { TaskRecord } from "./types";

export interface TaskAccountModel { account: string | null; model: string | null }

/** The account part of a runner id such as "opencode#oc-glm@devbox"; null when the id does not spell one out. */
export const runnerAccountId = (id: string | null | undefined): string | null => parseRunnerId(id ?? "")?.account ?? null;

/** `account` is the usage pool the attempt bills (or the runner id spells out); `model` prefers the actually launched model. */
export function taskAccountModel(t: TaskRecord): TaskAccountModel {
  const last = t.attempts.at(-1);
  if (t.state === "running") {
    return {
      account: t.pendingAttempt?.usageAtStart?.account ?? runnerAccountId(t.executor) ?? null,
      model: t.pendingAttempt?.model ?? null,
    };
  }
  const executor = t.result?.executor ?? t.executor ?? last?.executor ?? t.requestedExecutor ?? null;
  return {
    account: last?.usageAtStart?.account ?? runnerAccountId(executor) ?? null,
    model: last?.actualModel ?? last?.model ?? t.result?.model ?? null,
  };
}
