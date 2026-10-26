import type { HostClient } from "@pacer/plugin";
const unavailable = async (): Promise<never> => {
  throw Error("unexpected observation capability");
};
export const unavailableObservations: Pick<HostClient, "tasks" | "events"> = {
  tasks: { read: unavailable, list: unavailable },
  events: { subscribe: unavailable },
};
