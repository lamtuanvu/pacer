import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { Skeleton } from "../../ds/Patterns";

type Props = { query: RouteQuery };
/** The Dispatch home and Needs you load on demand, so the app bundle does not carry them. */
export function LazyDispatch({ view, query }: Props & { view: "home" | "needs-you" }) {
  const [screens, setScreens] = useState<Record<"home" | "needs-you", ComponentType<Props>> | null>(null),
    [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true; setError(false);
    void import("./Dispatch").then(m => { if (active) setScreens({ home: m.DispatchHome, "needs-you": m.NeedsYouPage }); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  const View = screens?.[view];
  return View ? <View query={query} /> : error
    ? <Alert tone="error" title={view === "home" ? "Could not load Dispatch" : "Could not load Needs you"}><Button onClick={() => retry(n => n + 1)}>Try again</Button></Alert>
    : <Skeleton layout={view === "home" ? "dashboard" : "list"} label={view === "home" ? "Loading Dispatch…" : "Loading Needs you…"} />;
}
