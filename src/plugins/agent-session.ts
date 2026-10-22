import { pluginRegistry } from "./index";
import { EXTENSION_METHODS } from "./protocol";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import type {
  AgentVersion,
  AgentSessionCapabilities,
  AgentSessionPrepare,
  AgentSessionLaunch,
  AgentAttachmentInput,
  AgentAttachmentDelivery,
} from "@pacer/plugin";

async function call<T>(ctx: Ctx, method: string, input: unknown): Promise<T> {
  const schema = EXTENSION_METHODS[method]!;
  const params = schema.params.safeParse(input);
  if (!params.success)
    throw new CoreError("invalid_input", params.error.message);
  const raw = await pluginRegistry(ctx).call(
    ctx,
    "pacer-agent-session",
    method,
    params.data,
  );
  const result = schema.result.safeParse(raw);
  if (!result.success)
    throw new CoreError(
      "plugin_refused",
      "Agent session adapter returned an invalid response",
    );
  return result.data as T;
}
export const agentSessionCapabilities = (ctx: Ctx, input: AgentVersion) =>
  call<AgentSessionCapabilities>(ctx, "agentSession.capabilities", input);
export const prepareAgentSession = (ctx: Ctx, input: AgentSessionPrepare) =>
  call<AgentSessionLaunch>(ctx, "agentSession.prepare", input);
export const prepareAgentAttachment = (ctx: Ctx, input: AgentAttachmentInput) =>
  call<AgentAttachmentDelivery>(ctx, "agentSession.attachment", input);
