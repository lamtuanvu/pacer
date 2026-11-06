import { diagnosticSummary, diagnosticRemediation } from '../../../../src/view-model/diagnostics';
import { executorLabel } from '../../../../src/view-model/words';

/** Account identities remain readable in text, tooltips and accessible names. */
export function settingsText(value: string): string {
  if (/--help.*failed/i.test(value)) return "The agent could not be checked. Review its setup in Agents and run Diagnostics again.";
  if (/pacer uninstall\b/i.test(value)) return "Disconnect the planner from Budget & pacing to undo these changes.";
  if (/\b\w+: (?:true|false)(?:;|$)|\/v[23]\//.test(value)) return "Review the connection in Diagnostics, then try again.";
  return value.replace(/\/(?:Users|Volumes|home)\/[^\s,;]+/g, path => displayPath(path)).replace(/\b(?:claude-code|codex|opencode|antigravity|cursor)(?:#[\w.-]+)?(?:@[\w.-]+)?\b/g, id => id.startsWith("opencode#") ? `OpenCode · ${id.slice(9).replace("@", " on ")}` : executorLabel(id));
}

/** The service may return another machine's home; do not expose that absolute path. */
export function displayPath(value: string): string {
  return value.replace(/^(?:\/Users\/[^/]+\/|\/home\/[^/]+\/|.*\/home\/)/, '~/');
}

/** Shared diagnostic copy never discards the original evidence in the row disclosure. */
export const diagnosticDetail = diagnosticSummary;
export const diagnosticNextStep = diagnosticRemediation;
