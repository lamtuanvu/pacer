export const executorName = (id: string | null | undefined): string => (NAMES[id ?? ""] ?? "the executor");
const NAMES: Record<string,string> = {"claude-code":"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",byteplus:"BytePlus",opencode:"OpenCode",local:"Local model"};
export function shortGoal(goal: string, max = 90): string {
  const text = goal.replace(/\s+/g," ").trim();
  if (text.length <= max) return text;
  const prefix=text.slice(0,max-1), space=prefix.lastIndexOf(" ");
  return prefix.slice(0,space>max/2?space:prefix.length)+"…";
}
export interface NotificationData { kind: "failed"|"done"|"broken"|"quota"|"strategy"|"session"; executor?: string; goal?: string; nextExecutor?: string; strategy?: string; resetsAt?: number; fromPanel?:boolean; near?:boolean }
