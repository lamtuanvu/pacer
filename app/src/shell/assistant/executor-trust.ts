import { assistantCliName, type AssistantCli } from "../../../../src/view-model/copy";

/** Asks whenever the assistant switches onto an executor backend (spec §7; persisting acknowledgement is open while decision 3 is unresolved). */
export const EXECUTOR_TRUST_TITLE = "Answer through the agent CLI?";
export const EXECUTOR_TRUST_LABEL = "Use the agent CLI";

export function executorTrustTitle(cli?: AssistantCli | null): string {
  return cli ? `Answer through ${assistantCliName(cli)}?` : EXECUTOR_TRUST_TITLE;
}

export function executorTrustLabel(cli?: AssistantCli | null): string {
  return cli ? `Use ${assistantCliName(cli)}` : EXECUTOR_TRUST_LABEL;
}

/** Trust copy branches on whether this CLI has proved live pacer tools (UI-12). */
export function executorTrustMessage(liveTools: boolean, cli?: AssistantCli | null): string {
  const who = cli ? assistantCliName(cli) : "The agent CLI";
  if (liveTools) {
    return `${who} runs on this machine as you. Built-in tools are denied; it may use only pacer's read tools after that path has been checked. If the CLI ever ignored its restrictions, it could read files you can read. Use it to answer?`;
  }
  return `${who} runs on this machine as you. Built-in tools are denied; it answers from pacer's summary only until a check proves pacer's read tools. If the CLI ever ignored its restrictions, it could read files you can read. Use it to answer?`;
}

/** @deprecated Prefer executorTrustMessage(liveTools); kept for callers that do not know the flag yet. */
export const EXECUTOR_TRUST_MESSAGE = executorTrustMessage(true);

export function confirmExecutorTrust(
  confirm: (message: string, title?: string, label?: string) => Promise<boolean>,
  liveTools = false,
  cli?: AssistantCli | null,
): Promise<boolean> {
  return confirm(executorTrustMessage(liveTools, cli), executorTrustTitle(cli), executorTrustLabel(cli));
}
