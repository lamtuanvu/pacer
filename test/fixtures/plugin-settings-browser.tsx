import { render } from "preact";
import { PluginsSection } from "../../app/src/screens/settings/Plugins";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { NotificationProvider } from "../../app/src/data/notification-context";
import { createActionRunner } from "../../app/src/data/actions";
import { initialState } from "../../app/src/data/store";
import { ApiError, type BrowserApi } from "../../app/src/data/api";

const call: BrowserApi["call"] = async <T,>(op: string, params: unknown) => {
  const response = await fetch(`/ops/${op}`, { method: "POST", body: JSON.stringify(params) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code, data.message);
  return data as T;
};
const api = { call } as BrowserApi;
const runner = createActionRunner({ call, waitFor: async () => true, refetch: () => {}, navigate: hash => { location.hash = hash; } });
const state = { ...initialState(), connected: !location.search.includes("disconnected") };
render(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={runner}><NotificationProvider><PluginsSection /></NotificationProvider></ActionContext.Provider></TaskContext.Provider>, document.getElementById("root")!);
