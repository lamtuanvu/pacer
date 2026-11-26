import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { Skeleton } from "../../ds/Patterns";

type Props = { query: RouteQuery; runId?: string; view?: "journey" };
let resolved: ComponentType<Props> | null = null;

export function LazyLive({ query, runId, view }: Props) {
  const [View, setView] = useState<ComponentType<Props> | null>(() => resolved);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("./LivePage").then(
      m => { resolved = m.LivePage; if (active) setView(() => resolved); },
      () => { if (active) setError(true); },
    );
    return () => { active = false; };
  }, [attempt]);
  return View
    ? <View query={query} runId={runId} view={view} />
    : error
      ? <Alert tone="error" title="Could not load the Live board"><Button onClick={() => retry(n => n + 1)}>Try again</Button></Alert>
      : <Skeleton layout="list" label="Loading the Live board…" />;
}
