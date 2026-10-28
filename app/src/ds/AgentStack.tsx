import { agentInfo, agentKey } from "../../../src/view-model/agents";
import { AgentMark } from "./AgentMark";

export function AgentStack({ agents, size = 18 }: { agents: string[]; size?: 16 | 18 | 20 }) {
  const unique = [...new Set(agents.map(agent => agentKey(agent) ?? agent))];
  if (!unique.length) return null;
  return <span className="pc-agent-stack" role="img" aria-label={unique.map(agent => agentInfo(agent).name).join(', ')}>
    {unique.map(agent => <AgentMark key={agent} agent={agent} size={size} labelled={false} />)}
  </span>;
}
