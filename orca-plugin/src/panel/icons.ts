import { escapeHtml } from "./shared";
import { AGENT_IDS, agentInfo, agentKey, markAgent } from "../../../src/view-model/agents";
import { AGENT_GLYPHS } from "../../../app/src/ds/agent-glyphs";
export { displayName } from "../../../src/view-model/format";

/** The same identity, tile treatment and glyph data as the app's AgentMark. */
export function icon(id: string, size=16, account?: string): string {
 const agent=markAgent(id, account), info=agentInfo(agent), key=agentKey(agent);
 const glyph=info.glyph ? AGENT_GLYPHS[info.glyph] : null, inner=Math.round(size*.66);
 const classes=["agent-mark", `agent-mark--${key ?? "unknown"}`, info.tile==="page-hairline" ? "agent-mark--hairline" : ""].filter(Boolean).join(" ");
 return `<span class="${classes}" role="img" aria-label="${escapeHtml(info.name)}" style="width:${size}px;height:${size}px;border-radius:${size*.28}px">${glyph ? `<svg width="${inner}" height="${inner}" viewBox="${glyph.viewBox}" aria-hidden="true" focusable="false"><path d="${glyph.path}" fill="currentColor"${glyph.evenOdd ? ' fill-rule="evenodd"' : ""}></path></svg>` : `<span class="monogram">${escapeHtml(info.monogram)}</span>`}</span>`;
}
export const agentStyle = `
.agent-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--agent-color,var(--ink));background:color-mix(in srgb,var(--agent-color,var(--ink)) 14%,transparent)}
.agent-mark--hairline{background:var(--surface-page);border:1px solid var(--line);color:var(--ink)}
.agent-mark--unknown{background:var(--ink);color:var(--ink-on-ink)}
${AGENT_IDS.map(id=>`.agent-mark--${id}{--agent-color:${agentInfo(id).color === "ink" ? "var(--ink)" : agentInfo(id).color}}`).join("\n")}
`;

export const mark = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="8" rx="4" fill="var(--border)"></rect><rect x="4" y="20" width="22" height="8" rx="4" fill="currentColor"></rect><rect class="brand-tick" x="29" y="12" width="4" height="24" rx="2"></rect></svg>`;

export const info = `<svg role="img" aria-label="Information" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7v1"></path></svg>`;
