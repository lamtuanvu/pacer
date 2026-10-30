import { lazy, Suspense } from "preact/compat";
import { Skeleton } from "../ds/Patterns";
const Activity = lazy(() => import("./Activity").then(module => ({ default: module.Activity })));
export function LazyActivity(props: { plugin: string; id: string }) {
  return <Suspense fallback={<Skeleton layout="settings" label="Loading plugin view…" />}><Activity {...props} /></Suspense>;
}
