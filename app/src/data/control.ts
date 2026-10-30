import { startPolling, type SchedulePoll } from './poll';
import type { ClientAction } from '../../../src/clients/control';
import type { BrowserApi } from './api';
import { applyTheme, savedTheme, THEME_KEY } from '../theme';
export interface ControlHost {
  getTheme(): string;
  setTheme(value: 'system' | 'light' | 'dark'): void;
  navigate(route: string): Promise<boolean>;
  native?(action: ClientAction): Promise<unknown>;
}
export async function applyClientAction(action: ClientAction, host: ControlHost): Promise<unknown> {
  if (action.type === 'theme.get') return {theme: host.getTheme()};
  if (action.type === 'theme.set') { host.setTheme(action.value); return {theme: host.getTheme()}; }
  if (action.type === 'navigate') {
    if (!await host.navigate(action.route)) throw Error('navigation_cancelled');
    return {route: action.route};
  }
  if (!host.native) throw Error('unsupported');
  return host.native(action);
}

/** One sequential poll per mounted page, credentials stay in this closure. */
export function startClientControl(api: BrowserApi, windowLabel: 'main' | 'tray', navigate: ControlHost['navigate'], schedule?: SchedulePoll): () => void {
  const native = (globalThis as typeof globalThis & {__TAURI__?: {core?: {invoke(command:string,args:Record<string,unknown>):Promise<unknown>}}}).__TAURI__?.core?.invoke;
  const host: ControlHost = {
    getTheme: () => savedTheme(),
    setTheme: value => {
      localStorage.setItem(THEME_KEY, value);
      applyTheme(value);
      window.dispatchEvent(new StorageEvent('storage', {key: THEME_KEY, newValue: value}));
    },
    navigate,
    ...(native ? {native: (action: ClientAction) => native('client_control', {action})} : {}),
  };
  let stopped = false;
  let enrollment: {client_id:string;worker_token:string} | undefined;
  const poll = async () => {
    try {
      if (!enrollment) {
        const hello = await api.hello();
        if (!hello.ops.includes('client.control.enroll')) return false as const;
        enrollment = await api.call('client.control.enroll', {kind: native ? 'desktop' : 'app', window: windowLabel});
      }
      if (stopped) return;
      const request = await api.call<{request_id:string;action:ClientAction} | null>('client.control.claim', enrollment);
      if (request && !stopped) {
        let result: unknown, error: string | undefined;
        try { result = await applyClientAction(request.action, host); }
        catch (e) { error = e instanceof Error && ['unsupported','navigation_cancelled'].includes(e.message) ? e.message : 'client_failed'; }
        if (!stopped) await api.call('client.control.complete', {request_id: request.request_id, worker_token: enrollment!.worker_token, ...(error ? {error} : {result})});
      }
    } catch (error) {
      // Service restart invalidates ephemeral workers. Never retry a claimed action.
      if ((error as {code?:string}).code === 'not_allowed') enrollment = undefined;
    }
  };
  const stop = startPolling(poll, 10_000, schedule);
  return () => { stopped = true; stop(); };
}
