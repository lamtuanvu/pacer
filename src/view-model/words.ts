/** The one vocabulary for statuses, verdicts, phases and modes. Every surface imports these; none spells a status on its own. */
export type StatusTone = "good" | "warn" | "bad" | "info" | "neutral";
export type Tone = StatusTone;

const tones: Record<string, StatusTone> = {
  good: "good", info: "info", warn: "warn", bad: "bad", muted: "neutral",
  EXHAUSTED: "bad", AHEAD: "warn", NEAR_LIMIT: "warn", EXPIRING: "warn", EXPIRING_SOON: "warn",
  OK: "good", ON_PACE: "good", BEHIND: "good", UNMETERED: "good",
  behind: "good", on_pace: "good", ahead: "warn", out: "bad",
};
/** Maps a tone or verdict string the service wrote to a status tone; the UI never derives one from numbers. */
export const toneFor = (value: string): StatusTone => Object.hasOwn(tones, value) ? tones[value]! : "neutral";

const verdicts: Record<string, string> = {
  ON_PACE: "Available", OK: "Available", UNMETERED: "Available", AHEAD: "Ahead of pace", BEHIND: "Behind pace", EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", NEAR_LIMIT: "Near limit", EXHAUSTED: "Out of quota",
  behind: "Behind pace", on_pace: "On pace", ahead: "Ahead of pace", out: "Out of quota", unknown: "Usage unknown",
};
export const verdictWords = (v: string): string => Object.hasOwn(verdicts, v) ? verdicts[v]! : "Unknown";

const phases: Record<string, string> = { starting: "Starting", working: "Editing", testing: "Testing", idle: "Idle", "lost-contact": "Lost contact", queued: "Queued" };
export const phaseWords = (phase: string): string => Object.hasOwn(phases, phase) ? phases[phase]! : phase;
export const modeWords = (mode: string): string => mode ? mode[0]!.toUpperCase() + mode.slice(1).toLowerCase() : mode;

/** The fields of an account that labels need; the app's richer Account type satisfies it. */
export interface AccountLike { name: string; runners?: string[]; source?: string; folder?: string; kind?: string; connection?: { base_url_host?: string } }

/** Public labels shared by every screen; account names distinguish endpoints. */
export function executorLabel(id: string | null | undefined, accounts: AccountLike[] = []): string {
  if (!id) return "Automatic";
  const [local, host] = id.split("@");
  const [agent, name] = local!.split("#");
  const account = accounts.find(a => a.runners?.includes(id) || a.name === name);
  const native = ({"claude-code":"Claude Code",claude:"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",antigravity:"Antigravity"} as Record<string,string>)[agent!];
  const defaultAccount = account?.source === "default" || (account?.folder && (
    (agent === "codex" && account.folder.endsWith("/.codex")) ||
    (agent === "claude-code" && account.folder.endsWith("/.claude"))
  ));
  const suffix = name && !defaultAccount ? ` · ${account?.name ?? name}` : "";
  const label = agent === "opencode" ? `${account?.name ?? name ?? "OpenCode"}` : `${native ?? agent}${suffix}`;
  return label + (host ? ` on ${host}` : "");
}
export function executorCaption(account?: AccountLike): string {
  if (account?.kind !== "endpoint") return "Agent CLI";
  return account.connection?.base_url_host ? `Model endpoint · ${account.connection.base_url_host}` : "External OpenCode provider";
}
export function taskStatus(task: { state: string; review?: { accepted: boolean } | null }): { label: string; tone: Tone } {
  if (task.review) return { label: task.review.accepted ? "Accepted" : "Rejected", tone: task.review.accepted ? "good" : "bad" };
  const labels: Record<string, [string, Tone]> = { needs_input: ["Needs your answer", "warn"], running: ["Working", "info"], queued: ["Queued", "neutral"], done: ["Done", "good"], partial: ["Partial", "warn"], failed: ["Failed", "bad"], limit: ["Out of quota", "warn"], stopped: ["Stopped", "neutral"] };
  const [label, tone] = labels[task.state] ?? [task.state, "neutral"];
  return { label, tone };
}
