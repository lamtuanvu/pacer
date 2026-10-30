import type { HostClient } from "@pacer/plugin";
const unavailable = async (): Promise<never> => {
  throw Error("unexpected observation capability");
};
/** Test hosts that never observe tasks, sign or redraw ui: each use fails loudly. */
export const unavailableObservations: Pick<HostClient, "tasks" | "events" | "identitySign" | "invalidate"> = {
  tasks: { read: unavailable, list: unavailable },
  events: { subscribe: unavailable },
  identitySign: async () => { throw Error("unexpected identity.sign capability"); },
  invalidate: () => { throw Error("unexpected ui.invalidate notification"); },
};
