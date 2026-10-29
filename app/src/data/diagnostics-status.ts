import { useEffect, useState } from 'preact/hooks';

export interface DiagnosticsStatus { issues: number; checked: boolean }
let status: DiagnosticsStatus = {issues: 0, checked: false};
const listeners = new Set<(value: DiagnosticsStatus) => void>();
export function recordDiagnostics(issues: number) {
  status = {issues, checked: true};
  for (const listener of listeners) listener(status);
}
export function useDiagnosticsStatus() {
  const [value, setValue] = useState(status);
  useEffect(() => { listeners.add(setValue); return () => {listeners.delete(setValue);}; }, []);
  return value;
}
