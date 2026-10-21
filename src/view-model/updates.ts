export interface UpdateCheck {
  latest?: string | null;
  error?: string;
  disabled?: boolean;
}
/** Stable desktop releases use MAJOR.MINOR.PATCH; other builds stay unchecked. */
export function desktopUpdateModel(current: string | null, report?: UpdateCheck) {
  const unchecked = {label:'Not checked',canUpdate:false};
  if (!current) return {label:'Version unavailable',canUpdate:false};
  if (report?.error) return {label:'Update check failed',canUpdate:false};
  if (report?.disabled) return {label:'Update checking disabled',canUpdate:false};
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(current) || !report?.latest || !stable.test(report.latest)) return unchecked;
  const installed = current.split('.').map(Number), latest = report.latest.split('.').map(Number);
  const difference = latest.map((part, i) => part - installed[i]!).find(part => part !== 0) ?? 0;
  const canUpdate = difference > 0;
  return {label:canUpdate ? `Update available: ${report.latest}` : 'Up to date',canUpdate};
}
