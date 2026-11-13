import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { Button } from "../../ds/Button";
import { Skeleton } from "../../ds/Patterns";

let resolvedView: ComponentType<any> | null = null;
export function LazyModelMatrix() {
  const [View, setView] = useState<ComponentType<any> | null>(() => resolvedView);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./ModelMatrix").then(module => {
      resolvedView = module.ModelMatrix;
      if (active) setView(() => module.ModelMatrix);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return View ? <View /> : error
    ? <div role="alert">Model matrix could not load. <Button onClick={() => retry(n => n + 1)}>Try again</Button></div>
    : <Skeleton layout="settings" label="Loading model matrix…" />;
}
