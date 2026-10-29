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
  return value.replace(/^(?:\/Users\/[^/]+\/|\/home\/[^/]+\/|.*\/home\/)/, '~/')
    .replace(/^\/(?!~)(?:[^/]+\/)+/, '~/');
}

/** Diagnostics describe the outcome, while implementation output stays out of the UI. */
export function diagnosticDetail(check: {name: string; detail: string; level: string; evidence?: string}): string {
  if (/\/v\d|\b\w+: (?:true|false)|;|--help|code object|\/Volumes\/|\/Users\/|\/home\//.test(check.detail)) {
    if (/snapshot/i.test(check.name)) return 'The local service responded to the performance check.';
    if (/CLI|Binary/.test(check.name)) return check.level === 'ok' ? 'The agent is installed and available.' : 'The agent could not be checked. Check its installation and try again.';
    if (/consent/i.test(check.name + check.detail)) return 'Review the requested integration changes before connecting.';
    if (/repo/i.test(check.name)) return check.level === 'ok' ? 'The repository is accessible.' : 'The repository could not be accessed.';
    return check.level === 'ok' ? 'Configuration is present. A real session is needed to verify the connection.' : 'This connection needs attention. Run the check again after reviewing your setup.';
  }
  return settingsText(check.detail.replace(/configuration only; runtime unverified/gi, 'a real session is still needed'));
}

/** Preserve useful recovery advice while replacing commands and implementation output. */
export function diagnosticNextStep(fix: string): string {
  return /(?:pacer |--|\/v\d|\b(?:codex|opencode|claude)\b|[\/\\])/.test(fix)
    ? 'Review the integration in Settings, then run the checks again.'
    : settingsText(fix);
}
