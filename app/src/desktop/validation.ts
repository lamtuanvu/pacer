import { platform } from '../platform';
export interface NativeValidationSetupResult {
  status: "verified" | "cancelled" | "timeout" | "settings_closed" | "target_exited" | "target_unavailable" | "host_unknown" | "settings_unavailable" | "already_open" | "setup_unavailable";
  accessibility: boolean;
  host_name?: string;
}
interface ValidationHost { platform: string; invoke?: (command: string) => Promise<unknown> }
export function createValidationIpc(host?:ValidationHost) {
  if (!host) return { supported: platform.nativeValidationSupported, setup: platform.setupNativeValidation };
  const supported=host.platform.startsWith("Mac")&&!!host.invoke;
  return {
    supported,
    setup:async():Promise<NativeValidationSetupResult>=>{
      if(!supported)throw Error("Native setup requires the macOS desktop app");
      return await host.invoke!("native_validation_setup") as NativeValidationSetupResult;
    },
  };
}
