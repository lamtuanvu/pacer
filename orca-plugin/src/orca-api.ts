export type OrcaEventName = "worktree.created" | "worktree.removed" | "agent.status.changed";
export interface WorkspaceContext { worktreeId?: string; branch: string; displayName: string; terminals: { id: string }[] }
export interface HostParams {
  "workspace.readContext": undefined;
  "terminal.sendText": { terminalId: string; text: string; enter?: boolean };
  "notifications.show": { title: string; body?: string };
  "storage.get": { key: string };
  "settings.get": undefined;
  "settings.set": { key: string; value: unknown };
  "events.subscribe": { events: string[] };
}
export interface HostResults {
  "workspace.readContext": WorkspaceContext | null;
  "terminal.sendText": { accepted: boolean };
  "notifications.show": { delivered: boolean };
  "storage.get": { value: unknown };
  "settings.get": { settings: Record<string, unknown> };
  "settings.set": { ok: true };
  "events.subscribe": { subscribed: OrcaEventName[] };
}
export interface OrcaHost { call<M extends keyof HostResults>(method: M, params?: HostParams[M]): Promise<HostResults[M]> }
export interface WorktreeCreated { worktreeId: string; path: string; branch: string }
export interface AgentStatusChanged { worktreeId: string | null; paneKey: string; state: string; receivedAt: number; mainAgent?: { state: string; outcome?: string; stateStartedAt: number } }
export interface OrcaWorkerContext {
  commands: { register(id: string, handler: (args?: unknown) => unknown): void };
  events: { on(name: string, handler: (payload: unknown) => void | Promise<void>): void };
  host: OrcaHost;
  grantedCapabilities: string[];
  log(message: string): void;
}
