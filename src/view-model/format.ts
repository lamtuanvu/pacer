const names: Record<string, string> = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", local: "Local model", opencode: "OpenCode" };
export const displayName = (id: string) => Object.hasOwn(names, id) ? names[id] : id;
export function duration(seconds: number, long = false): string {
  const minutes = Math.max(0, Math.floor(seconds / 60)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (long) return days ? `${days} ${days === 1 ? "day" : "days"} ${hours % 24} ${hours % 24 === 1 ? "hour" : "hours"}` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
export const backIn = (at: number | null, now: number) => at === null ? "reset unknown" : `back in ${duration(at - now)}`;
