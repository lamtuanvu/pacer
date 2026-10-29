import { useEffect } from "preact/hooks";
import type { Route } from "../../router";

/** Bridge the shell's agent links to the Agents screen's existing details control.
 * The screen loads asynchronously; observe only until its matching control appears.
 */
export function useAgentDeepLink(route: Route) {
  const agent =
    route.name === "settings" &&
    route.section === "executors" &&
    typeof location !== "undefined"
      ? new URLSearchParams(location.hash.split("?")[1]).get("agent")
      : null;
  useEffect(() => {
    if (!agent) return;
    const open = () => {
      const target = [
        ...document.querySelectorAll<HTMLButtonElement>("[data-details]"),
      ].find((node) => node.dataset.details === agent);
      if (!target) return false;
      if (target.getAttribute("aria-expanded") !== "true") target.click();
      target.focus();
      return true;
    };
    if (open()) return;
    const observer = new MutationObserver(() => {
      if (open()) observer.disconnect();
    });
    observer.observe(document.getElementById("main-content") ?? document.body, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [agent]);
}
