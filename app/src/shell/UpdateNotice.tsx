import { useMemo, useRef, useState } from "preact/hooks";
import { updateIntent, updateNotice, updateNoticeKey } from "../../../src/view-model/updates";
import { useActions } from "../data/action-context";
import { UpdateNoticeCard } from "../ds/UpdateNoticeCard";
import { useDialogs } from "../ds/useDialogs";
import { ErrorMessage, useTaskContext } from "../screens/task-shared";

/** Session-local dismissal survives navigation; no background action grants restart permission. */
export function UpdateNotice({ hidden = false, narrow = false }: { hidden?: boolean; narrow?: boolean }) {
  const { state } = useTaskContext(), runner = useActions(), dialogs = useDialogs();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), intent = useMemo(() => updateIntent(), []);
  const status = updateNotice(state.snapshot?.desktopUpdates, dismissed);
  const current = useRef(status); current.current = status;
  const eligible = !hidden && !state.sessionEnded && state.connected && state.features.ops.has("desktop.update.restart");
  const allowed = useRef(eligible); allowed.current = eligible;
  function restoreFocus() { document.getElementById("main-content")?.focus(); }
  async function restart() {
    if (!status || pending.current || !state.connected) return;
    pending.current = true;
    try {
      if (!await dialogs.confirm(`Restart pacer to install ${status.target}? Active work and sessions will be allowed to finish first.`, "Restart to update", "Restart to update")) return;
      // A confirmation can stay open while another client changes the update.
      if (!allowed.current || current.current?.target !== status.target || current.current?.installationId !== status.installationId || current.current?.revision !== status.revision) return;
      setBusy(true); setError(undefined);
      const result = await runner.run(`desktop:${status.installationId}`, intent(status, "restart"));
      if (result.status === "error") setError(new Error(`${result.message}${result.hint ? ` · ${result.hint}` : ""}`));
      else if (result.status === "done") { setDismissed(previous => new Set([...previous, updateNoticeKey(status)])); restoreFocus(); }
    } catch (error) { setError(error); }
    finally { pending.current = false; setBusy(false); }
  }
  const visible = eligible && status;
  return <>{visible && <UpdateNoticeCard key={updateNoticeKey(status)} version={status.target!} busy={busy} narrow={narrow} restart={() => void restart()} later={() => {
    setDismissed(previous => new Set([...previous, updateNoticeKey(status)])); setError(undefined); restoreFocus();
  }}><ErrorMessage error={error}/></UpdateNoticeCard>}{dialogs.dialog}</>;
}
