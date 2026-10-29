import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { Button } from "../../ds/Button";
import { LoadingState } from "../../ds/Patterns";

/** Loaded on demand so the assistant's settings stay out of the main bundle. */
export function LazyAssistantSettings() {
  const [View, setView] = useState<ComponentType | null>(null), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true; setError(false);
    void import("./AssistantSettings").then(module => { if (active) setView(() => module.AssistantSettingsSection); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return View ? <View /> : error ? <div role="alert">Assistant settings could not load. <Button onClick={() => retry(n => n + 1)}>Try again</Button></div> : <LoadingState label="Loading assistant…" />;
}
