import type { Model } from "./accounts";
export type Step = 1 | 2 | 3 | 4;
export const agents = [{ id: "claude-code", name: "Claude Code", tagline: "Anthropic · weekly + 5h limits" }, { id: "codex", name: "Codex", tagline: "OpenAI · weekly limit" }, { id: "cursor", name: "Cursor", tagline: "Monthly requests" }, { id: "agy", name: "Antigravity", tagline: "No limit reported" }, { id: "opencode", name: "Model endpoint (OpenCode)", tagline: "Providers you use in OpenCode, local models, or a URL" }];
export const blankWizard = { agent: "claude-code", account: "", name: "", base_url: "", key_source: "file", env_var: "", models: "[]", usage: "unmetered" };
export type WizardDraft = typeof blankWizard;
export const nextStep = (step: Step, agent: string): Step => step === 2 && agent !== "opencode" ? 4 : Math.min(4, step + 1) as Step;
export const previousStep = (step: Step, agent: string): Step => step === 4 && agent !== "opencode" ? 2 : Math.max(1, step - 1) as Step;
export function validateWizard(step: Step, draft: WizardDraft): string | null {
  if (step === 2 && ["claude-code", "codex"].includes(draft.agent) && !draft.account) return "Choose or create an account.";
  if (step === 2 && draft.agent === "opencode" && !draft.account && !/^[a-z0-9][a-z0-9-]*$/.test(draft.name)) return "Enter a lowercase account name using letters, digits and hyphens.";
  if (step !== 3) return null;
  try { if (!["http:", "https:"].includes(new URL(draft.base_url).protocol)) throw Error(); } catch { return "Enter an HTTP or HTTPS base URL."; }
  if (!["keychain", "file", "env", "none"].includes(draft.key_source)) return "Choose a key source.";
  if (draft.key_source === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.env_var)) return "Enter a valid environment variable name.";
  if (!["quota", "metered", "unmetered"].includes(draft.usage)) return "Choose usage.";
  try {
    const models = JSON.parse(draft.models) as Model[];
    if (!Array.isArray(models) || !models.length || models.some(m => !m.id?.trim() || !Number.isInteger(m.context) || m.context! <= 0 || !Number.isInteger(m.output) || m.output! <= 0)) return "Choose models and enter positive context and output limits.";
  } catch { return "Choose models and enter their limits."; }
  return null;
}
export function endpointParams(draft: WizardDraft, key: string) {
  return { kind: "endpoint", name: draft.name, base_url: draft.base_url, key_source: draft.key_source,
    ...(key && ["keychain", "file"].includes(draft.key_source) ? { key } : {}), ...(draft.key_source === "env" ? { env_var: draft.env_var } : {}),
    models: (JSON.parse(draft.models) as Model[]).map(m => ({ ...m, tools: m.tools ?? true })), usage: draft.usage, test: true };
}

export function endpointResult(added: {state: string | {state: string; detail?: string}; detail?: string}): {state:string;detail?:string} {
  return typeof added.state === "string" ? {state:added.state,...(added.detail ? {detail:added.detail} : {})} : added.state;
}
export const modelsFound = (count: number) => `${count} ${count === 1 ? "model" : "models"} found. Choose models below.`;

/** The Add agent wizard's draft. Every value is a string so the draft survives a reload. */
export const blankAgentDraft = { step: "1", agent: "codex", account: "", host: "", maxTasks: "1", model: "", kinds: "", createdId: "", jobId: "" };
export type AgentDraft = typeof blankAgentDraft;
export const REMOTE_AGENTS = ["codex", "claude-code"];
/** Agents that bill to a pacer account; the others use their own sign-in. */
export const accountRequired = (agent: string) => ["codex", "claude-code", "opencode"].includes(agent);
/** Task kinds offered as "Good at", in the dispatcher's words. */
export const AGENT_KINDS = [["feature", "Features"], ["tests", "Tests"], ["debug", "Debugging"], ["docs", "Docs"], ["refactor", "Refactors"], ["boilerplate", "Boilerplate"]] as const;

/** What stops a step from being complete, in words the step shows; null when it can move on. */
export function agentStepProblem(step: number, draft: AgentDraft, facts: { installed?: boolean | null; hosts: readonly string[] }): string | null {
  if (step === 1) return facts.installed === false ? "This agent isn’t installed on this machine. Install it, then check again." : null;
  if (step === 2) return accountRequired(draft.agent) && !draft.account ? "Choose or create an account." : null;
  if (step === 3) {
    if (draft.host && !REMOTE_AGENTS.includes(draft.agent)) return "Only Codex and Claude Code can run on a remote host.";
    if (draft.host && !facts.hosts.includes(draft.host)) return "Choose a remote host.";
    const tasks = Number(draft.maxTasks);
    return Number.isInteger(tasks) && tasks >= 1 && tasks <= 16 ? null : "Enter a whole number from 1 to 16.";
  }
  return null;
}
/** The furthest step the user can open: every earlier step must be complete. Once added, only the test step remains. */
export function furthestAgentStep(draft: AgentDraft, facts: Parameters<typeof agentStepProblem>[2]): number {
  if (draft.createdId) return 4;
  for (let step = 1; step < 4; step++) if (agentStepProblem(step, draft, facts)) return step;
  return 4;
}
