import { agentInfo, agentKey } from "../../../src/view-model/agents";
import { AGENT_GLYPHS } from "./agent-glyphs";

export interface AgentMarkProps { agent: string; size?: number; labelled?: boolean }
/** Brand colours come from a class per agent in components.css; only sizes are set inline. */
export function AgentMark({ agent, size = 20, labelled = true }: AgentMarkProps) {
  const info = agentInfo(agent), key = agentKey(agent);
  const glyph = info.glyph ? AGENT_GLYPHS[info.glyph] : null, inner = Math.round(size * 0.66);
  const className = ["pc-agent-mark", key ? `pc-agent-mark--${key}` : "pc-agent-mark--unknown", info.tile === "page-hairline" && "pc-agent-mark--hairline"].filter(Boolean).join(" ");
  const a11y = labelled ? { role: "img" as const, "aria-label": info.name } : { "aria-hidden": "true" as const };
  return <span className={className} style={{ "--agent-size": `${size}px` }} {...a11y}>
    {glyph
      ? <svg width={inner} height={inner} viewBox={glyph.viewBox} aria-hidden="true" focusable="false"><path d={glyph.path} fill="currentColor" fill-rule={glyph.evenOdd ? "evenodd" : undefined} /></svg>
      : <span className="pc-agent-mark__mono">{info.monogram}</span>}
  </span>;
}
