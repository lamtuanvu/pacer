/**
 * The assistant's entry point for the rest of the shell. This module stays in the main bundle and is tiny: the sheet
 * itself loads lazily. The ⌘K menu's `?` mode (a follow-up to the command menu) calls `assistantEntry.ask(...)`, and
 * shows the mode only while `assistantEntry.available()` is true (UI-13).
 */
export interface AssistantRequest {
  /** Sent as the question when present; the sheet opens either way. */
  text?: string;
  /** ⌘↵ in the menu asks in a new conversation; Enter continues the current one. */
  newConversation?: boolean;
}
type Listener = (request: AssistantRequest) => void;
const listeners = new Set<Listener>();
const watchers = new Set<() => void>();
let ready = false, pending: AssistantRequest | null = null;
export const assistantEntry = {
  /** True once the service reports the assistant usable. Set by the sheet's host. */
  available: (): boolean => ready,
  setAvailable(next: boolean): void { if (next !== ready) { ready = next; watchers.forEach(w => w()); } },
  /** Re-renders the caller when availability changes. */
  watch(watcher: () => void): () => void { watchers.add(watcher); return () => { watchers.delete(watcher); }; },
  ask(request: AssistantRequest = {}): void {
    if (listeners.size) listeners.forEach(l => l(request)); else pending = request;
  },
  /** The host registers here; a request made before it loaded is delivered once. */
  listen(listener: Listener): () => void {
    listeners.add(listener);
    if (pending) { const request = pending; pending = null; listener(request); }
    return () => { listeners.delete(listener); };
  },
};
