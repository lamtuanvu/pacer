import { opencodeReportingSource } from "./opencode-report";
import type {
  AgentIdentityInput, AgentIdentityPlan, AgentVersion, AgentSessionCapabilities, AgentSessionPrepare, AgentSessionLaunch,
  AgentAttachmentInput, AgentAttachmentDelivery,
} from "@pacer/plugin";
import { PluginError } from "@pacer/plugin";

/** Inspect actual option tokens, not substrings such as --model-provider. */
function hasOption(help: string, option: string): boolean {
  return new RegExp(`(?:^|[\\s,])${option}(?=[\\s,=<]|$)`).test(help);
}
const required: Record<string, string[]> = {
  codex: ["--config", "--cd", "--sandbox", "--add-dir", "--model", "--image", "--dangerously-bypass-hook-trust"],
  "claude-code": ["--session-id", "--resume", "--add-dir", "--model", "--settings"],
  opencode: ["--standalone", "--session", "--prompt"],
};

export function capabilities(input: AgentVersion): AgentSessionCapabilities {
  const {agent, help, resumeHelp, apiHelp} = input;
  let reason: string | undefined;
  if (!Object.hasOwn(required, agent)) reason = `Interactive sessions are not implemented for ${agent}.`;
  else if (help !== undefined) {
    const missing = required[agent]!.filter(option => !hasOption(help, option));
    if (missing.length) reason = `${agent} is missing interactive CLI options: ${missing.join(", ")}. Update this CLI or choose another executor.`;
    else if (agent === "codex" && resumeHelp !== undefined) {
      const missingResume = ["--cd", "--sandbox", "--add-dir", "--model"].filter(option => !hasOption(resumeHelp, option));
      if (missingResume.length) reason = `codex resume is missing CLI options: ${missingResume.join(", ")}.`;
    } else if (agent === "opencode" && apiHelp !== undefined && !hasOption(apiHelp, "--standalone")) {
      reason = "OpenCode needs a standalone API command to create and recover native sessions. Update this CLI.";
    }
  }
  const supported = reason === undefined;
  return {interactive: supported, resume: supported, launchImages: supported && agent === "codex", liveImages: false, files: supported, ...(reason ? {reason} : {})};
}

export function attachment(input: AgentAttachmentInput): AgentAttachmentDelivery {
  const cap = capabilities(input);
  if (!cap.interactive) return {kind: "unsupported", reason: cap.reason!};
  if (input.phase === "launch" && input.agent === "codex" && input.attachment.mime.startsWith("image/")) {
    return {kind: "native", args: ["-i", input.attachment.path]};
  }
  return {kind: "reference", text: `Use the attached file ${JSON.stringify(input.attachment.name)} at ${JSON.stringify(input.attachment.path)}.`, requiresUserSubmit: true};
}

export function prepare(input: AgentSessionPrepare): AgentSessionLaunch {
  const cap = capabilities(input);
  if (!cap.interactive) throw new PluginError("not_allowed", cap.reason!);
  if (input.sessionId && input.newSessionId) throw new PluginError("invalid_input", "Choose a fresh identity or a resume identity, not both.");
  const references: string[] = [], images: string[] = [];
  for (const file of input.sessionId ? [] : input.attachments) {
    const delivery = attachment({...input, attachment: file, phase: "launch"});
    if (delivery.kind === "native") images.push(...delivery.args);
    else if (delivery.kind === "reference") references.push(delivery.text);
    else throw new PluginError("not_allowed", delivery.reason);
  }
  const prompt = [input.request, ...references].join("\n\n");
  const dirs = [...new Set([input.runDir, ...(input.attachmentDir ? [input.attachmentDir] : [])])].flatMap(path => ["--add-dir", path]);
  let argv: string[];
  if (input.agent === "codex") {
    const help = input.sessionId ? input.resumeHelp ?? input.help : input.help;
    argv = ["codex", ...(input.sessionId ? ["resume"] : []), ...(help === undefined || hasOption(help, "--no-daemon") ? ["--no-daemon"] : []),
      "-C", input.workspace, "-s", "workspace-write", ...dirs, ...(input.model ? ["-m", input.model] : []), ...images, "--", input.sessionId ?? prompt];
  } else if (input.agent === "claude-code") {
    argv = ["claude", ...dirs, ...(input.model ? ["--model", input.model] : []),
      ...(input.sessionId ? ["--resume", input.sessionId] : [...(input.newSessionId ? ["--session-id", input.newSessionId] : []), "--", prompt])];
  } else {
    const id = input.sessionId ?? input.newSessionId;
    argv = ["opencode", "--standalone", ...(id ? ["--session", id] : []), ...(input.sessionId ? [] : ["--prompt", prompt])];
  }
  const nativeId = input.sessionId ?? input.newSessionId;
  return {argv, cwd: input.workspace,
    ...(input.agent === "opencode" && nativeId ? {reporting: {
      source: opencodeReportingSource(nativeId, input.runDir), configEnv: "OPENCODE_CONFIG_CONTENT", configKey: "plugins",
    }} : {})};
}

/** The host executes this plan in the selected workspace/account and persists the result. */
export function identity(input: AgentIdentityInput): AgentIdentityPlan {
  const cap = capabilities(input);
  if (!cap.interactive) throw new PluginError("not_allowed", cap.reason!);
  if (input.agent === "opencode") {
    if (input.sessionId) return {kind: "command", argv: ["opencode", "api", "--standalone", "session.get", "--param", `sessionID=${input.sessionId}`], idPath: ["data", "id"]};
    let model: {providerID: string; id: string} | undefined;
    if (input.model) {
      const slash = input.model.indexOf("/");
      if (slash < 1 || slash === input.model.length - 1) throw new PluginError("invalid_input", "OpenCode models must use provider/model format.");
      model = {providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1)};
    }
    return {kind: "command", argv: ["opencode", "api", "--standalone", "session.create", "--data", JSON.stringify({title: `pacer ${input.taskId}`, agent: "build", ...(model ? {model} : {})})], idPath: ["data", "id"]};
  }
  if (input.sessionId) return {kind: "assigned", id: input.sessionId};
  if (input.agent === "claude-code") return {kind: "assigned", id: crypto.randomUUID()};
  return {kind: "none"};
}

export const handlers = {
  "agentSession.identity": (input: unknown) => identity(input as AgentIdentityInput),
  "agentSession.capabilities": (input: unknown) => capabilities(input as AgentVersion),
  "agentSession.prepare": (input: unknown) => prepare(input as AgentSessionPrepare),
  "agentSession.attachment": (input: unknown) => attachment(input as AgentAttachmentInput),
};
