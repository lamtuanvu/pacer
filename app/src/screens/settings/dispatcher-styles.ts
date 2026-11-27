import { useEffect } from "preact/hooks";
import styles from "./dispatcher.css" with { type: "text" };

const styled = new WeakSet<Document>();
/** Dispatcher › Overview, Who can run what and Profiles styles; they load with the lazy Dispatcher chunk, not app.js. */
export function useDispatcherStyles() {
  useEffect(() => { if (styled.has(document)) return; const sheet = new CSSStyleSheet(); sheet.replaceSync(styles); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; styled.add(document); }, []);
}
