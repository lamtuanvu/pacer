import { TextAction } from "../../ds/Button";
import { SettingsBoard, useScoped } from "./shared";

/** Shown when Pair finds no pairing plugin. It names no product: pairing comes only from plugins. */
export function PairingView() {
  const scoped = useScoped();
  return <SettingsBoard id="pairing" title="Pair machines" caption="Pairing lets this machine use another machine’s executors. It is provided by plugins, and none is installed or enabled.">
    <p><TextAction href={scoped("#/settings/plugins")}>Open Plugins settings</TextAction></p>
  </SettingsBoard>;
}
