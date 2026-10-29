import { useEffect, useState } from "preact/hooks";
import type { RouteQuery } from "../../router";

/** Shared by two lazy screens; the shell does not carry panel content in app.js. */
export function LazyWorkPanels(props: {
  query: RouteQuery;
  selected?: string | null;
}) {
  const [View, setView] = useState<typeof import("./WorkPanels").WorkPanels>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void import("./WorkPanels").then(
      (module) => {
        if (active) setView(() => module.WorkPanels);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return View ? (
    <View {...props} />
  ) : error ? (
    <p role="alert">Could not load side panels. Reload to try again.</p>
  ) : null;
}
