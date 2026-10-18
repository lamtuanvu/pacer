import { useEffect } from "preact/hooks";
import { Settings } from "./Settings";
import { Executors } from "./Executors";
import { Accounts } from "./Accounts";
import { Strategy } from "./Strategy";
/** Settings › General for Phase 1: today's settings screens stacked under section anchors (Phase 3 replaces them). */
export function SettingsGeneral({ section }: { section?: string }) {
  useEffect(() => { if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" }); }, [section]);
  return <div className="pc-settings">
    <div id="settings-planner"><Settings /></div>
    <div id="settings-executors"><Executors /></div>
    <div id="settings-accounts"><Accounts /></div>
    <div id="settings-strategies"><Strategy /></div>
  </div>;
}
