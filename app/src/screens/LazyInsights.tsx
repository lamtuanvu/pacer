import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../router";
import { Button } from "../ds/Button";
export function LazyInsights({ query }: { query: RouteQuery }) {
  const [View, setView] = useState<ComponentType<{ query: RouteQuery }> | null>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./insights/Insights").then(
      (module) => {
        if (active) setView(() => module.Insights);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return View ? (
    <View query={query} />
  ) : (
    <div role="status">
      {error ? "Could not load Insights." : "Loading insights…"}
      {error && (
        <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      )}
    </div>
  );
}
