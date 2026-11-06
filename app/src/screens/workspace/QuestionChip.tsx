import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { AgentMark } from "../../ds/AgentMark";
import { Button } from "../../ds/Button";

/** Floating idle cue for a pending agent question; does not reflow the terminal. */
export function QuestionChip({ agent, text, onOpen }: { agent?: string | null; text: string; onOpen: () => void }) {
  const id = markAgent(agent ?? "unknown");
  const name = agent ? agentInfo(id).name : "The agent";
  const preview = text.trim().replace(/\s+/g, " ");
  return <Button type="button" variant="quiet" className="pc-workspace-question-chip" onClick={onOpen}
    aria-label={`${name} asks: ${preview}. Open answer panel.`}>
    <AgentMark agent={id} size={16} labelled={false} />
    <span className="pc-workspace-question-chip__body">
      <span className="pc-workspace-question-chip__title">{name} asks</span>
      <span className="pc-workspace-question-chip__text">{preview}</span>
    </span>
    <span className="pc-workspace-question-chip__action">Answer</span>
  </Button>;
}
