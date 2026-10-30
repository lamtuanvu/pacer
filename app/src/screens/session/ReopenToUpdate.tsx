import { Alert } from "../../ds/Alert";

/** A live session whose host is outside the service's support window. It keeps running; nothing is stopped. */
export function ReopenToUpdate({ host }: { host?: { pacer: string | null; supported: boolean } | null }) {
  if (!host || host.supported) return null;
  return <Alert tone="warning" title="Reopen to update">
    {`This session started on ${host.pacer ? `pacer ${host.pacer}` : "an older pacer"}. It keeps running, but cannot update in place. Reopen it to use the current version.`}
  </Alert>;
}
