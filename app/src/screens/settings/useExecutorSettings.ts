import { useEffect, useRef, useState } from "preact/hooks";
import { createExecutorDraft, executorSavePayload, isExecutorDraftDirty, matchesExecutorDraft, validateExecutorDraft, type ExecutorDraft, type ExecutorSettings } from "../../model/executor-settings";
import { useNotifications } from "../../data/notification-context";
import { useTaskContext } from "../task-shared";
import { useResource } from "./shared";

type SaveResult = ExecutorSettings & { warnings?: string[] };
/** Same order, Takes work and limits: a newer revision that differs only elsewhere in the strategy. */
export const sameSettings = (a: ExecutorSettings, b: ExecutorSettings) => JSON.stringify(createExecutorDraft(a)) === JSON.stringify(createExecutorDraft(b));
const isConflict = (error: unknown) => !!error && typeof error === "object" && ((error as { code?: unknown }).code === "conflict" || /changed elsewhere/i.test(String((error as { message?: unknown }).message ?? "")));

/**
 * The page draft of executor order and parallel limits (`runner.settings.*`), plus the immediate Takes work write.
 * Saves are revision-checked; a lost response is confirmed against the saved values before it is reported.
 */
export function useExecutorSettings() {
  const { state, api } = useTaskContext();
  const query = useResource<ExecutorSettings>("runner.settings.get");
  const notifications = useNotifications();
  const [saved, setSaved] = useState<ExecutorSettings>(), [draft, setDraft] = useState<ExecutorDraft>();
  const [busy, setBusy] = useState(false), [enabledBusy, setEnabledBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), observed = useRef<ExecutorSettings>();
  if (query.data) observed.current = query.data;
  const dirty = !!saved && !!draft && isExecutorDraftDirty(draft, saved);
  const errors = draft ? validateExecutorDraft(draft) : {};
  // Other writes (this page's switches, models, account policy) move the one strategy revision without touching
  // these settings; only a different order or limit is a conflict.
  const conflict = dirty && !!saved && !!query.data && saved.revision !== query.data.revision && !sameSettings(saved, query.data);
  useEffect(() => {
    if (!query.data || query.data.revision === saved?.revision || pending.current) return;
    if (!dirty) { setSaved(query.data); setDraft(createExecutorDraft(query.data)); }
    else if (saved && sameSettings(saved, query.data)) setSaved(query.data);
  }, [query.data]);
  const discard = () => { if (query.data) { setSaved(query.data); setDraft(createExecutorDraft(query.data)); setError(undefined); } query.reload(); };
  const edit = (fn: (next: ExecutorDraft) => void) => {
    if (!draft || busy) return;
    const next = { order: [...draft.order], runners: Object.fromEntries(Object.entries(draft.runners).map(([id, r]) => [id, { ...r }])) };
    fn(next); setDraft(next); setError(undefined);
  };
  /** Another write on this page moved the strategy revision without touching these settings. */
  const rebase = (revision: string) => setSaved(current => current ? { ...current, revision } : current);
  /** `expectedRevision` is the revision another save on this page just produced. */
  const save = async (expectedRevision?: string): Promise<boolean> => {
    if (!saved || !draft || !dirty || pending.current || !state.connected || Object.keys(errors).length || (conflict && !expectedRevision)) return false;
    const base = expectedRevision ? { ...saved, revision: expectedRevision } : saved;
    // Settings observed before this save; only a reading that arrives during it can be another client's commit.
    const seen = observed.current?.revision;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      let result: SaveResult;
      let current = base;
      try { result = await api.call<SaveResult>("runner.settings.save", executorSavePayload(draft, base)); }
      catch (failure) {
        // A lost response can follow a committed write. Confirm actual values before retrying.
        const actual = await api.call<ExecutorSettings>("runner.settings.get", {}).catch(() => null);
        if (actual && actual.revision !== base.revision && matchesExecutorDraft(draft, actual)) {
          result = actual;
          notifications?.notify({ key: "executor-save-confirmed", tone: "warning", title: "Saved settings confirmed", message: "The save response was interrupted. Review routing warnings before delegating." });
        } else if (actual && isConflict(failure) && sameSettings(actual, base)) {
          // The revision moved by a write that left these settings alone: retry once on top of it.
          current = actual;
          result = await api.call<SaveResult>("runner.settings.save", executorSavePayload(draft, actual));
        } else { query.reload(); throw failure; }
      }
      // The response describes our write, not necessarily the latest settings:
      // another client can commit before that response reaches this window.
      const latest = await api.call<ExecutorSettings>("runner.settings.get", {}), event = observed.current;
      const confirmed = event && event.revision !== seen && event.revision !== base.revision && event.revision !== current.revision && event.revision !== result.revision && event.revision !== latest.revision ? event : latest;
      if (!matchesExecutorDraft(draft, confirmed)) {
        query.setData(confirmed);
        throw new Error("Settings changed after this save. Your draft is preserved. Reload saved settings before retrying.");
      }
      setSaved(confirmed); setDraft(createExecutorDraft(confirmed)); query.setData(confirmed);
      if (result.warnings?.length) notifications?.notify({ key: "executor-save-warnings", tone: "warning", title: "Routing needs attention", message: result.warnings.join(" ") });
      return true;
    } catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  /** Takes work is an immediate write based exclusively on saved settings; page edits stay in the draft. */
  const saveEnabled = async (id: string, enabled: boolean): Promise<string> => {
    if (!saved || pending.current || !state.connected) throw new Error("Wait for the service before changing Takes work.");
    pending.current = true; setEnabledBusy(true);
    try {
      const latest = await api.call<ExecutorSettings>("runner.settings.get", {});
      if (latest.revision !== saved.revision && !sameSettings(latest, saved)) {
        query.setData(latest);
        throw new Error("Settings changed elsewhere. Reload saved settings before retrying.");
      }
      const next = createExecutorDraft(latest);
      if (!next.runners[id]) throw new Error("This executor was removed. Reload saved settings.");
      next.runners[id].enabled = enabled;
      let result: SaveResult;
      try { result = await api.call<SaveResult>("runner.settings.save", executorSavePayload(next, latest)); }
      catch (failure) {
        const actual = await api.call<ExecutorSettings>("runner.settings.get", {}).catch(() => null);
        if (!actual || actual.revision === latest.revision || !matchesExecutorDraft(next, actual)) { query.reload(); throw failure; }
        result = actual;
      }
      const confirmed = await api.call<ExecutorSettings>("runner.settings.get", {});
      if (!matchesExecutorDraft(next, confirmed)) {
        query.setData(confirmed);
        throw new Error("Settings changed after this save. Reload saved settings before retrying.");
      }
      setSaved(confirmed);
      // Preserve order and task-limit edits made in the page draft.
      setDraft(current => current ? { ...current, runners: { ...current.runners, [id]: { ...current.runners[id]!, enabled } } } : createExecutorDraft(confirmed));
      query.setData(confirmed);
      if (result.warnings?.length) notifications?.notify({ key: "executor-save-warnings", tone: "warning", title: "Routing needs attention", message: result.warnings.join(" ") });
      return confirmed.revision;
    } finally { pending.current = false; setEnabledBusy(false); }
  };
  /** Pick up settings a save elsewhere on this page made current, unless the draft holds edits. */
  const refresh = async () => {
    const latest = await api.call<ExecutorSettings>("runner.settings.get", {}).catch(() => null);
    if (latest) query.setData(latest);
  };
  return { query, saved, draft, dirty, errors, conflict, busy, enabledBusy, error, edit, save, saveEnabled, discard, rebase, refresh, clearError: () => setError(undefined) };
}
export type ExecutorSettingsState = ReturnType<typeof useExecutorSettings>;
