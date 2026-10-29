import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { LoadingState } from "../../ds/Patterns";
import type { RouteQuery } from "../../router";
export interface ResultPageProps { id: string; query: RouteQuery; failure?: boolean }
/** Result screens and diff parsing stay outside the startup bundle. */
export function LazyResultPage(props: ResultPageProps) {
  const [View, setView] = useState<ComponentType<ResultPageProps> | null>(null), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true; setError(false);
    void import("./ResultPage").then(m => { if (active) setView(() => m.ResultPage); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return View ? <View {...props}/> : error ? <div role="alert">Could not load this result. <Button onClick={() => retry(n => n + 1)}>Try again</Button></div> : <LoadingState label="Loading result…"/>;
}
