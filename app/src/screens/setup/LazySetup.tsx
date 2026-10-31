import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";

import { Skeleton } from "../../ds/Patterns";

type SetupProps = { query: RouteQuery };
/** Setup is needed on first run only, so it loads as its own chunk. */
export function LazySetup(props: SetupProps) {
  const [View, setView] = useState<ComponentType<SetupProps> | null>(null), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void import("./Setup").then(module => { if (active) setView(() => module.Setup); }).catch(() => { if (active) setError("Could not load Setup."); });
    return () => { active = false; };
  }, [attempt]);
  return View ? <View {...props} /> : !error ? <Skeleton layout="settings" label="Loading Setup…" /> : <div className="pc-setup" role={error ? "alert" : "status"}>{error}{error && <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button>}</div>;
}
