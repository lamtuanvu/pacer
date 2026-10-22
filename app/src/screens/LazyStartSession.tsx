import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { Button } from "../ds/Button";
export function LazyStartSession() {
  const [View, setView] = useState<ComponentType | null>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./StartSession").then(
      (module) => {
        if (active) setView(() => module.StartSession);
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
    <View />
  ) : (
    <div role="status">
      {error ? "Could not load the session composer." : "Loading composer…"}
      {error && (
        <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      )}
    </div>
  );
}
