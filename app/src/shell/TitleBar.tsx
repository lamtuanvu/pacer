import { TrafficLights } from "../ds/TrafficLights";
import { windowControls } from "../data/desktop";

/** Native controls share the page's top bar; browsers render no window chrome. */
export function TitleBar() {
  const controls = windowControls();
  if (!controls.desktop) return null;
  return <TrafficLights desktop onClose={() => void controls.close()}
    onMinimize={() => void controls.minimize()} onMaximize={() => void controls.toggleMaximize()} />;
}
