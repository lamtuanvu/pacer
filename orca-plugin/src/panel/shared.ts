export function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
}
export const h = (v: unknown) => escapeHtml(String(v ?? ""));
export const time = (at: number) => new Date(at * 1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
export function duration(seconds: number, long=false): string {
  const minutes=Math.max(0,Math.floor(seconds/60)), hours=Math.floor(minutes/60), days=Math.floor(hours/24);
  if(long) return days ? `${days} ${days===1?"day":"days"} ${hours%24} ${hours%24===1?"hour":"hours"}` : `${hours} ${hours===1?"hour":"hours"}`;
  return days ? `${days}d ${hours%24}h` : hours ? `${hours}h ${minutes%60}m` : `${minutes}m`;
}
export const backIn = (at: number | null, now: number) => at === null ? "reset unknown" : `back in ${duration(at-now)}`;
export const age = (at: number, now: number) => `${duration(now-at)} ago`;
