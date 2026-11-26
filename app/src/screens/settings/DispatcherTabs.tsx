import type { ModelRecord } from "../../../../src/dispatch/types";
import { NavTabs } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { useTaskContext } from "../task-shared";
import { useResource, useScoped } from "./shared";

/** Dispatcher sections, in tab order; each is its own route so it deep-links. */
export const DISPATCHER_TABS = [
  { section: "dispatcher", label: "Overview" },
  { section: "agents", label: "Agents" },
  { section: "rules", label: "Who can run what" },
  { section: "profiles", label: "Profiles" },
] as const;
export type DispatcherTab = typeof DISPATCHER_TABS[number]["section"];
export const isDispatcherTab = (section: string | undefined): section is DispatcherTab => DISPATCHER_TABS.some(tab => tab.section === section);

/** Agents with a model on whose size is not set yet: difficulty cannot steer them. */
export function unratedRunners(models: readonly ModelRecord[]): number {
  return new Set(models.filter(model => model.binding.kind === "exact" && model.tier === "unknown").map(model => model.runner)).size;
}

function UnratedPill() {
  const inventory = useResource<{ models: ModelRecord[] }>("dispatch.models");
  const count = inventory.data ? unratedRunners(inventory.data.models) : 0;
  return count ? <Pill tone="warn">{count} unrated</Pill> : null;
}

/** The Dispatcher page head: its one title and the section tabs (aria-current on the open one). */
export function DispatcherHead({ current }: { current: DispatcherTab }) {
  const scoped = useScoped(), { state } = useTaskContext();
  return <header className="pc-settings-board__header pc-dispatcher-head">
    <h1>Dispatcher</h1>
    <NavTabs label="Dispatcher sections" items={DISPATCHER_TABS.map(tab => ({
      href: scoped(`#/settings/${tab.section}`), current: tab.section === current,
      label: tab.section === "agents" && state.features.ops.has("dispatch.models") ? <>{tab.label} <UnratedPill /></> : tab.label,
    }))} />
  </header>;
}
