export interface AttachmentMetadata { id: string; name: string; mime: string; size: number }
/** Only host-to-adapter messages include a resolved, private filesystem path. */
export interface AttachmentRef extends AttachmentMetadata { path: string }
export interface AgentVersion {
  agent: string; version: string;
  /** Installed CLI interfaces, supplied by the host under the selected account. */
  help?: string; resumeHelp?: string; apiHelp?: string;
}
export interface AgentSessionCapabilities {
  interactive: boolean; resume: boolean; launchImages: boolean; liveImages: boolean; files: boolean; reason?: string;
}
export interface AgentSessionPrepare extends AgentVersion {
  request: string; workspace: string; runDir: string; attachments: AttachmentRef[];
  permissionPolicy: "native"; model?: string; sessionId?: string;
  attachmentDir?: string;
  /** Assigned identity for a fresh conversation; sessionId is exclusively resume. */
  newSessionId?: string;
}
export interface AgentSessionLaunch {
  argv: string[]; cwd: string; stdin?: string;
  /** Per-run native reporting plugin; the host writes it privately and preserves config. */
  reporting?: {source: string; configEnv: string; configKey: string};
}
export interface AgentAttachmentInput extends AgentVersion {
  workspace: string; attachment: AttachmentRef; phase: "launch" | "live";
}
export type AgentAttachmentDelivery = {kind: "native"; args: string[]}
  | {kind: "reference"; text: string; requiresUserSubmit: true}
  | {kind: "unsupported"; reason: string};

export interface AgentIdentityInput extends AgentVersion { taskId: string; sessionId?: string; model?: string }
export type AgentIdentityPlan = {kind: "none"} | {kind: "assigned"; id: string}
  | {kind: "command"; argv: string[]; idPath: string[]};
