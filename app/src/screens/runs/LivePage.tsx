/** One entry for the Live board family: the several-runs board, one run's Live board, or its journey playback. */
import type { RouteQuery } from "../../router";
import { JourneyPlayback } from "./JourneyPlayback";
import { LiveBoard } from "./LiveBoard";
import { MultiRun } from "./MultiRun";

export function LivePage({ query, runId, view }: { query: RouteQuery; runId?: string; view?: "journey" }) {
  if (!runId) return <MultiRun query={query} />;
  return view === "journey" ? <JourneyPlayback key={runId} runId={runId} query={query} /> : <LiveBoard key={runId} runId={runId} query={query} />;
}
