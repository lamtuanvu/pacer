import { platform } from '../platform';
import { createTrayIpc as createHostTrayIpc } from '../platform/tray';
import type { TrayHost } from '../platform/tray';
export { appHref } from '../platform/tray';
export type { TrayHost, TrayIpc } from '../platform/tray';
export function createTrayIpc(host?: TrayHost) {
  return host === undefined ? platform.tray : createHostTrayIpc(host);
}
