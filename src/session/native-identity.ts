import { execProcess } from "../exec/process";
import { planAgentIdentity } from "../plugins/agent-session";
import type { AgentIdentityInput } from "@pacer/plugin";
import type { Ctx } from "../types";
import type { RunRef } from "../tasks/types";

/** Execute the adapter's native identity plan, never infer the most recent history. */
export async function conversationIdentity(ctx: Ctx, input: AgentIdentityInput & {
  workspace: string; env: Record<string, string | undefined>;
}): Promise<RunRef["agentSession"]> {
  const plan = await planAgentIdentity(ctx, input);
  if (plan.kind === "none") return undefined;
  const source = input.sessionId ? "lookup" : "assigned";
  if (plan.kind === "assigned") return {id: plan.id, source};
  const result = await execProcess({argv: plan.argv, cwd: input.workspace, env: input.env, timeoutMs: 15000});
  let id: unknown;
  try {
    id = JSON.parse(result.stdout);
    for (const key of plan.idPath) id = id && typeof id === "object" && Object.hasOwn(id, key) ? (id as Record<string, unknown>)[key] : undefined;
  } catch { /* invalid output is an explicit refusal below */ }
  if (result.code !== 0 || result.timedOut || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || (input.sessionId && id !== input.sessionId)) {
    // CLI output may include account data; keep the diagnostic specific without echoing it.
    throw Error(input.sessionId ? `${input.agent} could not recover this native session. Check that its history still exists in the selected account.`
      : `${input.agent} could not create a native session. Check this account's CLI configuration.`);
  }
  return {id, source};
}
