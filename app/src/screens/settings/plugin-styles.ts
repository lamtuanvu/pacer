import { useEffect } from "preact/hooks";
import styles from "./plugin-settings.css" with { type: "text" };
const styled = new WeakSet<Document>();
export function usePluginSettingsStyles() {
  useEffect(() => { if (styled.has(document)) return; const sheet = new CSSStyleSheet(); sheet.replaceSync(styles); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; styled.add(document); }, []);
}
