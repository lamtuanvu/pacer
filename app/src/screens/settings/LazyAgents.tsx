import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { Button } from "../../ds/Button";
import { Skeleton } from "../../ds/Patterns";
import type { AgentsTabProps } from "./agents-tab-props";

let resolvedView: ComponentType<AgentsTabProps> | null = null;
/** Dispatcher › Agents loads on demand, so its editors stay out of the settings entry chunk. */
export function LazyAgents(props: AgentsTabProps) {
  const [View, setView] = useState<ComponentType<AgentsTabProps> | null>(() => resolvedView);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (View) return;
    let active = true;
    setError(false);
    void import("./Agents").then(module => {
      resolvedView = module.AgentsTab;
      if (active) setView(() => module.AgentsTab);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return View ? <View {...props} /> : error
    ? <div role="alert">Agents could not load. <Button onClick={() => retry(n => n + 1)}>Try again</Button></div>
    : <Skeleton layout="settings" label="Loading agents…" />;
}
