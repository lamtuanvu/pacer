import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { Skeleton } from "../../ds/Patterns";

type Props = { query: RouteQuery; runId?: string };
let resolved: ComponentType<Props> | null = null;

export function LazyRuns({ query, runId }: Props) {
  const [View, setView] = useState<ComponentType<Props> | null>(() => resolved);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./RunsPage").then(
      m => { resolved = m.RunsPage; if (active) setView(() => resolved); },
      () => { if (active) setError(true); },
    );
    return () => { active = false; };
  }, [attempt]);
  return View
    ? <View query={query} runId={runId} />
    : error
      ? <Alert tone="error" title="Could not load Runs"><Button onClick={() => retry(n => n + 1)}>Try again</Button></Alert>
      : <Skeleton layout="list" label="Loading Runs…" />;
}
