import { render } from "preact";
import { useState } from "preact/hooks";
import { PanelTabs, type PanelTab } from "../../app/src/ds/PanelTabs";

// Browser fixture: a controlled PanelTabs with six tabs, two of them in the overflow menu.
const tabs: PanelTab[] = ["Summary", "Files", "Checks", "Logs", "Notes", "History"].map((label, at) => ({ id: label.toLowerCase(), label, ...(at === 2 ? { badge: 3 } : {}) }));
function App() {
  const [value, setValue] = useState("summary");
  return <><PanelTabs label="Task details" tabs={tabs} value={value} onChange={setValue} /><output id="value">{value}</output></>;
}
render(<App />, document.getElementById("app")!);
