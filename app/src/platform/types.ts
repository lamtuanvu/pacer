import type { ClientAction } from '../../../src/clients/control';
import type { SessionSocket } from '../term/client';
import type { DesktopUpdateConnection, WindowControls } from './native';
import type { NativeValidationSetupResult } from '../desktop/validation';
import type { TrayIpc } from './tray';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'incompatible';
/** Transport construction stays here; protocol negotiation and retries stay with callers. */
export interface Platform {
  readonly desktop: boolean;
  subscribeDesktopConnection?(listener: (state: import('./ipc').DesktopConnection) => void): () => void;
  request(path: string, init?: RequestInit): Promise<Response>;
  subscribeEvents(path: string): EventSource;
  attachTerminal(url: string): SessionSocket;
  subscribeConnection(listener: (status: ConnectionStatus) => void): () => void;
  setConnectionStatus(status: ConnectionStatus): void;
  openExternal(url: string): void;
  confirm(message: string): Promise<boolean>;
  pickFiles(options?: { multiple?: boolean }): Promise<File[]>;
  pickFolder(): Promise<File[]>;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  notify(title: string, options?: NotificationOptions): Promise<boolean>;
  readonly windowControls: WindowControls;
  readRoundedWindowSupport(): Promise<boolean>;
  readNativeTitlebarSupport(): Promise<boolean>;
  readDesktopVersion(): Promise<string | null>;
  readDesktopUpdateConnection(): Promise<DesktopUpdateConnection | null>;
  openDesktopTakeover(): Promise<void>;
  reportSessionEnded(): void;
  clientControl(action: ClientAction): Promise<unknown>;
  readonly nativeValidationSupported: boolean;
  setupNativeValidation(): Promise<NativeValidationSetupResult>;
  readonly tray: TrayIpc;
}
