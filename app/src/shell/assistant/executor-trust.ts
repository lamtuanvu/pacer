/** Asks whenever the assistant switches onto an executor backend (spec §7; persisting acknowledgement is open while decision 3 is unresolved). */
export const EXECUTOR_TRUST_MESSAGE =
  "The agent CLI runs on this machine as you, restricted to answering from pacer's summary: every tool is denied and the restriction was checked. If the CLI ever ignored its restrictions, it could read files you can read. Use it to answer?";
export const EXECUTOR_TRUST_TITLE = "Answer through the agent CLI?";
export const EXECUTOR_TRUST_LABEL = "Use the agent CLI";

export function confirmExecutorTrust(
  confirm: (message: string, title?: string, label?: string) => Promise<boolean>,
): Promise<boolean> {
  return confirm(EXECUTOR_TRUST_MESSAGE, EXECUTOR_TRUST_TITLE, EXECUTOR_TRUST_LABEL);
}
