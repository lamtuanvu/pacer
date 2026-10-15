import { duration } from "../../../src/view-model/format";
export { duration, backIn } from "../../../src/view-model/format";
export function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
}
export const h = (v: unknown) => escapeHtml(String(v ?? ""));
export const time = (at: number) => new Date(at * 1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
export const age = (at: number, now: number) => `${duration(now-at)} ago`;

/** Lossless run packing keeps large repeated snapshot strings within the panel budget. */
export function packPanelData(value: unknown): unknown {
 if(typeof value === "string" && value.length>=32) {
  const runs: [string,number][]=[];
  for(const char of value) { const last=runs.at(-1); if(last?.[0]===char) last[1]++; else runs.push([char,1]); }
  const packed={ $runs:runs };
  return JSON.stringify(packed).length<JSON.stringify(value).length ? packed : value;
 }
 if(Array.isArray(value)) return value.map(packPanelData);
 if(value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,packPanelData(v)]));
 return value;
}

export const actionStatus = '<p data-status role="status" aria-live="polite" class="action-status"></p>';
