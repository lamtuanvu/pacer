import { Alert } from "../../ds/Alert";
import { Button } from "../../ds/Button";

/** A live session whose host is outside the service's support window. It keeps running; nothing is stopped. */
export function ReopenToUpdate({ host, onReopen, actionLabel = "Create a new task" }: { host?: { pacer: string | null; supported: boolean } | null; onReopen?: () => void; actionLabel?: string }) {
  if (!host || host.supported) return null;
  return <Alert tone="warning" title="Reopen to update" compact>
    {`This session started on ${host.pacer ? `pacer ${host.pacer}` : "an older pacer"}. It keeps running, but cannot update in place. Start fresh work to use the current version.`}
    {onReopen && <div className="pc-alert__actions"><Button size="sm" onClick={onReopen}>{actionLabel}</Button></div>}
  </Alert>;
}
