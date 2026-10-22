import type {
  AgentVersion,
  AgentSessionCapabilities,
  AgentSessionPrepare,
  AgentSessionLaunch,
  AgentAttachmentInput,
  AgentAttachmentDelivery,
} from "@pacer/plugin";
import { PluginError } from "@pacer/plugin";

// Verified CLI help: codex-cli 0.163.0, Claude Code 2.1.281, OpenCode 2.1.2.
export function capabilities({
  agent,
  version,
}: AgentVersion): AgentSessionCapabilities {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supported =
    !!match &&
    (agent === "codex"
      ? Number(match[1]) === 0 &&
        Number(match[2]) >= 162 &&
        (Number(match[2]) > 162 || Number(match[3]) >= 1)
      : agent === "claude-code"
        ? Number(match[1]) === 2
        : agent === "opencode"
          ? Number(match[1]) === 2
          : agent === "cursor"
            ? Number(match[1]) >= 1
            : false);
  return {
    interactive: supported,
    resume: supported && agent !== "cursor",
    launchImages: supported && agent === "codex",
    liveImages: false,
    files: supported,
    ...(!supported
      ? { reason: "This agent/version has no verified interactive adapter." }
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
  const models = input.model
    ? [input.agent === "codex" ? "-m" : "--model", input.model]
    : [];
  const dirs = [
    input.runDir,
    ...(input.attachmentDir && input.attachmentDir !== input.runDir
      ? [input.attachmentDir]
      : []),
  ].flatMap((path) => ["--add-dir", path]);
  let argv: string[];
  if (input.agent === "codex")
    argv = [
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
  else if (input.agent === "claude-code")
    argv = [
      "claude",
      ...dirs,
      ...models,
      ...(input.sessionId ? ["--resume", input.sessionId] : ["--", prompt]),
    ];
  else if (input.agent === "opencode") {
    if (input.model)
      throw new PluginError(
        "not_allowed",
        "Interactive OpenCode model overrides are not verified; choose its configured model.",
      );
    argv = [
      "opencode",
      "--standalone",
      ...(input.sessionId
        ? ["--session", input.sessionId]
        : ["--prompt", prompt]),
      input.workspace,
    ];
  } else
    argv = [
      "cursor-agent",
      "--workspace",
      input.workspace,
      ...models,
      "--",
      prompt,
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
