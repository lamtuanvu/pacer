import { ago, elapsed } from './time';
import { executorLabel } from './words';

const reasons: Record<string, string> = {
  ok: 'Available capacity', available: 'Available', unmetered: 'No quota limit',
  'on pace': 'On pace', behind: 'Capacity available before reset', ahead: 'Ahead of quota pace',
  expiring: 'Quota resets soon', 'near limit': 'Near quota limit', exhausted: 'Out of quota',
  unknown: 'Usage not available', busy: 'Busy with another task', full: 'At capacity',
  planner: 'Reserved for planning', disabled: 'Turned off', 'not configured': 'Setup needed',
  'not installed': 'Agent needs installing', 'signed out': 'Sign-in needed',
  'over budget': 'Quota budget reached', 'not signed in': 'Sign-in needed', 'Blocked by you': 'Paused by you',
  'Best available capacity': 'Best available capacity',
};
/** Unknown service strings never become visible copy; the original belongs in technical details. */
export function reasonCopy(raw: string | null | undefined): string {
  if (!raw) return 'Routing details not recorded';
  if (Object.hasOwn(reasons, raw)) return reasons[raw]!;
  const usage = raw.match(/^([a-z ]+), used (\d+(?:\.\d+)?)%(?: \/ pace (\d+(?:\.\d+)?)%)?$/);
  if (usage && Object.hasOwn(reasons, usage[1]!)) return `${reasons[usage[1]!]!} · ${usage[2]}% of quota used${usage[3] ? ` (planned ${usage[3]}%)` : ''}`;
  if (raw.includes('; ')) return raw.split('; ').map(reasonCopy).join('; ');
  const busy = raw.match(/^(.+) busy$/);
  if (busy) return `${executorLabel(busy[1])} is busy`;
  return 'Routing details available';
}
export function costCopy(cost: {account: string; deltaPct: number | null; window: string | null; reason?: string} | null): string {
  if (!cost) return 'Cost not recorded';
  const account = executorLabel(cost.account);
  if (cost.deltaPct === null) return `${account} · ${cost.reason === 'shared' ? 'quota shared with other runs; individual usage unavailable' : 'quota readings unavailable'}`;
  if (cost.deltaPct === 0) return `${account} · no measured quota increase`;
  const windows: Record<string,string> = {weekly:'weekly quota',week:'weekly quota',daily:'daily quota',day:'daily quota',session:'session quota','5h':'five-hour quota'};
  const window = Object.hasOwn(windows, cost.window ?? '') ? windows[cost.window!] : 'quota';
  return `${account} · used ${cost.deltaPct}% of ${window}`;
}
const kinds: Record<string,string> = {boilerplate:'Routine setup',tests:'Tests',docs:'Documentation',rename:'Renaming',migration:'Migration',feature:'Feature work',debug:'Debugging',refactor:'Refactoring',performance:'Performance', 'unfamiliar-code':'Explore unfamiliar code',research:'Research'};
export const kindCopy = (kind: string) => Object.hasOwn(kinds, kind) ? kinds[kind]! : 'Other work';
export const kindSourceCopy = (source?: string) => source === 'brief' ? 'Chosen in the task brief' : source === 'classifier' ? 'Suggested from the task description' : 'Work type not recorded';
export const branchCopy = (branch?: string | null) => branch || 'Branch not recorded';
export const executorIdHelp = (created: boolean) => `Used in routing rules and the CLI.${created ? '' : ' Suggested id; the final id appears after you add the executor.'}`;

const events: Record<string,string> = {
  Testing:'Running checks', testing:'Running checks', done:'Run completed', partial:'Run ended with work to review',
  failed:'Run failed', limit:'Run stopped at the quota limit', stopped:'Run stopped', running:'Run started', queued:'Run queued', needs_input:'Waiting for your answer',
  'hook: PostToolUse':'Agent finished a tool step', 'hook: PreToolUse':'Agent started a tool step',
  'hook: Stop':'Agent finished responding', 'hook: SessionStart':'Agent session started', 'hook: SessionEnd':'Agent session ended',
};
export function timelineCopy(entries: {at:number; text:string}[]) {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = `${entry.at}:${entry.text}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(entry => {
    let text = Object.hasOwn(events, entry.text) ? events[entry.text] : undefined;
    if (!text && /^\d+ commits?$/.test(entry.text)) text = entry.text;
    if (!text && entry.text.startsWith('Worktree created from ')) text = 'Working copy created';
    if (!text && entry.text.startsWith('Routed to ')) text = 'Executor selected';
    return {...entry, text:text ?? 'Session activity recorded', raw:entry.text};
  });
}
export function sessionTime(task: {state:string; attemptStartedAt?:number|null; updatedAt:number}, now:number): string {
  if (task.state === 'running' && task.attemptStartedAt != null) return `running for ${elapsed(now-task.attemptStartedAt)}`;
  if (task.state === 'queued') return `queued for ${elapsed(now-task.updatedAt)}`;
  return `last updated ${ago(task.updatedAt,now)}`;
}
