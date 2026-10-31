import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { Button } from "../../ds/Button";
import { Skeleton } from "../../ds/Patterns";
import type { RouteQuery } from "../../router";

/** The composer is its own chunk, so app.js stays inside its gzip budget. */
export function LazyNewTask({ query }: { query: RouteQuery }) {
  const [View, setView] = useState<ComponentType<{ query: RouteQuery }> | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./NewTask").then(module => { if (active) setView(() => module.NewTask); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  if (View) return <View query={query} />;
  return error ? <div role="status">Could not load the New task composer. <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button></div> : <Skeleton layout="settings" label="Loading composer…" />;
}
