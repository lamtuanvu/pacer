import type { Platform, ConnectionStatus } from './types';
import type { SessionSocket } from '../term/client';
import { createTrayIpc } from './tray';

interface FileHandle { kind: 'file'; getFile(): Promise<File> }
interface DirectoryHandle { values(): AsyncIterable<FileHandle | DirectoryHandle>; kind: string }
interface PickerHost {
  showOpenFilePicker?(options: { multiple: boolean }): Promise<FileHandle[]>;
  showDirectoryPicker?(): Promise<DirectoryHandle>;
}
const pickerHost = () => globalThis as typeof globalThis & PickerHost;
async function cancelledPicker<T>(pick: () => Promise<T>, empty: T): Promise<T> {
  try { return await pick(); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') return empty; throw error; }
}
async function folderFiles(directory: DirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === 'directory') files.push(...await folderFiles(entry as DirectoryHandle));
    else files.push(await (entry as FileHandle).getFile());
  }
  return files;
}
export function createBrowserPlatform(): Platform {
  let status: ConnectionStatus = 'connecting';
  const listeners = new Set<(status: ConnectionStatus) => void>();
  return {
    desktop: false,
    request: (path, init) => fetch(path, init),
    subscribeEvents: path => new EventSource(path),
    attachTerminal: url => new WebSocket(url) as unknown as SessionSocket,
    subscribeConnection(listener) { listeners.add(listener); listener(status); return () => { listeners.delete(listener); }; },
    setConnectionStatus(next) { if (status === next) return; status = next; for (const listener of listeners) listener(status); },
    openExternal: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
    // Native browser dialogs are banned (they do not exist in desktop webviews); browser screens confirm with useDialogs().
    confirm: async () => false,
    pickFiles: options => cancelledPicker(async () => {
      const host = pickerHost();
      if (!host.showOpenFilePicker) throw Error('File picker unavailable in this browser');
      return Promise.all((await host.showOpenFilePicker({ multiple: options?.multiple ?? false })).map(handle => handle.getFile()));
    }, []),
    pickFolder: () => cancelledPicker(async () => {
      const host = pickerHost();
      if (!host.showDirectoryPicker) throw Error('Folder picker unavailable in this browser');
      return folderFiles(await host.showDirectoryPicker());
    }, []),
    clipboard: { readText: () => navigator.clipboard.readText(), writeText: text => navigator.clipboard.writeText(text) },
    notify: async (title, options) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
      new Notification(title, options); return true;
    },
    windowControls: { desktop: false, minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {} },
    readRoundedWindowSupport: async () => false,
    readNativeTitlebarSupport: async () => false,
    readDesktopVersion: async () => null,
    readDesktopUpdateConnection: async () => null,
    openDesktopTakeover: async () => { throw Error('Desktop takeover unavailable'); },
    reportSessionEnded() {},
    clientControl: async () => { throw Error('unsupported'); },
    nativeValidationSupported: false,
    setupNativeValidation: async () => { throw Error('Native setup requires the macOS desktop app'); },
    tray: createTrayIpc({ location: { assign: url => globalThis.location?.assign(url) } }),
  };
}
