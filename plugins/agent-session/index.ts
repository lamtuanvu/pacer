import type {
  AgentVersion,
  AgentSessionCapabilities,
  AgentSessionPrepare,
  AgentSessionLaunch,
  AgentAttachmentInput,
  AgentAttachmentDelivery,
} from "@pacer/plugin";
import { PluginError } from "@pacer/plugin";

// Interactive release validation covers Codex 0.163.0. Other installed CLIs
// remain available to the ordinary delegated runner, but are not offered here.
export function capabilities({
  agent,
  version,
}: AgentVersion): AgentSessionCapabilities {
  const supported = agent === "codex" && version === "0.163.0";
  return {
    interactive: supported,
    resume: supported,
    launchImages: supported,
    liveImages: false,
    files: supported,
    ...(!supported
      ? { reason: "Interactive sessions are currently validated for Codex 0.163.0 only." }
      : {}),
  };
}

export function attachment(
  input: AgentAttachmentInput,
): AgentAttachmentDelivery {
  const cap = capabilities(input);
  if (!cap.interactive) return { kind: "unsupported", reason: cap.reason! };
  if (
    input.phase === "launch" &&
    input.agent === "codex" &&
    input.attachment.mime.startsWith("image/")
  ) {
    return { kind: "native", args: ["-i", input.attachment.path] };
  }
  return {
    kind: "reference",
    text: `Use the attached file ${JSON.stringify(input.attachment.name)} at ${JSON.stringify(input.attachment.path)}.`,
    requiresUserSubmit: true,
  };
}

export function prepare(input: AgentSessionPrepare): AgentSessionLaunch {
  const cap = capabilities(input);
  if (!cap.interactive) throw new PluginError("not_allowed", cap.reason!);
  if (input.sessionId && !cap.resume)
    throw new PluginError(
      "not_allowed",
      "This agent cannot resume through Pacer.",
    );
  const references: string[] = [],
    images: string[] = [];
  for (const file of input.sessionId ? [] : input.attachments) {
    const delivery = attachment({
      ...input,
      attachment: file,
      phase: "launch",
    });
    if (delivery.kind === "native") images.push(...delivery.args);
    else if (delivery.kind === "reference") references.push(delivery.text);
    else throw new PluginError("not_allowed", delivery.reason);
  }
  const prompt = [input.request, ...references].join("\n\n");
  const models = input.model ? ["-m", input.model] : [];
  const dirs = [
    input.runDir,
    ...(input.attachmentDir && input.attachmentDir !== input.runDir
      ? [input.attachmentDir]
      : []),
  ].flatMap((path) => ["--add-dir", path]);
  const argv = [
    "codex",
    ...(input.sessionId ? ["resume"] : []),
    "--no-daemon",
    "-C",
    input.workspace,
    "-s",
    "workspace-write",
    ...dirs,
    ...models,
    ...images,
    "--",
    input.sessionId ?? prompt,
  ];
  return { argv, cwd: input.workspace };
}

export const handlers = {
  "agentSession.capabilities": (input: unknown) =>
    capabilities(input as AgentVersion),
  "agentSession.prepare": (input: unknown) =>
    prepare(input as AgentSessionPrepare),
  "agentSession.attachment": (input: unknown) =>
    attachment(input as AgentAttachmentInput),
};
