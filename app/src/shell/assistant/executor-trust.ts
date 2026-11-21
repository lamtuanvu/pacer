/** Asks whenever the assistant switches onto an executor backend (spec §7; persisting acknowledgement is open while decision 3 is unresolved). */
export const EXECUTOR_TRUST_TITLE = "Answer through the agent CLI?";
export const EXECUTOR_TRUST_LABEL = "Use the agent CLI";

/** Trust copy branches on whether this CLI has proved live pacer tools (UI-12). */
export function executorTrustMessage(liveTools: boolean): string {
  if (liveTools) {
    return "The agent CLI runs on this machine as you. Built-in tools are denied; it may use only pacer's read tools after that path has been checked. If the CLI ever ignored its restrictions, it could read files you can read. Use it to answer?";
  }
  return "The agent CLI runs on this machine as you. Built-in tools are denied; it answers from pacer's summary only until a check proves pacer's read tools. If the CLI ever ignored its restrictions, it could read files you can read. Use it to answer?";
}

/** @deprecated Prefer executorTrustMessage(liveTools); kept for callers that do not know the flag yet. */
export const EXECUTOR_TRUST_MESSAGE = executorTrustMessage(true);

export function confirmExecutorTrust(
  confirm: (message: string, title?: string, label?: string) => Promise<boolean>,
  liveTools = false,
): Promise<boolean> {
  return confirm(executorTrustMessage(liveTools), EXECUTOR_TRUST_TITLE, EXECUTOR_TRUST_LABEL);
}
