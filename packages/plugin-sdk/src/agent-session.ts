export interface AttachmentMetadata { id: string; name: string; mime: string; size: number }
/** Only host-to-adapter messages include a resolved, private filesystem path. */
export interface AttachmentRef extends AttachmentMetadata { path: string }
export interface AgentVersion { agent: string; version: string }
export interface AgentSessionCapabilities {
  interactive: boolean; resume: boolean; launchImages: boolean; liveImages: boolean; files: boolean; reason?: string;
}
export interface AgentSessionPrepare extends AgentVersion {
  request: string; workspace: string; runDir: string; attachments: AttachmentRef[];
  permissionPolicy: "native"; model?: string; sessionId?: string;
  attachmentDir?: string;
}
export interface AgentSessionLaunch { argv: string[]; cwd: string; stdin?: string }
export interface AgentAttachmentInput extends AgentVersion {
  workspace: string; attachment: AttachmentRef; phase: "launch" | "live";
}
export type AgentAttachmentDelivery = {kind: "native"; args: string[]}
  | {kind: "reference"; text: string; requiresUserSubmit: true}
  | {kind: "unsupported"; reason: string};
