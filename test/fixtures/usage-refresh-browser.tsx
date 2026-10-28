import { render } from "preact";
import { StatusBar } from "../../app/src/shell/StatusBar";
import { TaskContext } from "../../app/src/screens/task-shared";
import { initialState } from "../../app/src/data/store";
import { ApiError, type BrowserApi } from "../../app/src/data/api";
import { createKeyRegistry } from "../../app/src/keys/registry";
import type { ClientSnapshot } from "../../src/view-model/snapshot";
import type { Route } from "../../app/src/router";
import fixture from "./ui/snapshot.json";

const call: BrowserApi["call"] = async <T,>(op: string, params: unknown) => {
  const response = await fetch(`/ops/${op}`, { method: "POST", body: JSON.stringify(params) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code, data.message);
  return data as T;
};
const state = { ...initialState(), connected: true };
const route = { name: "dispatch", query: { repo: null, scope: null } } as Route;
const registry = createKeyRegistry({ controlActive: () => false });
render(<TaskContext.Provider value={{ state, api: { call } as BrowserApi }}><StatusBar route={route} snapshot={fixture as unknown as ClientSnapshot} registry={registry} /></TaskContext.Provider>, document.getElementById("root")!);
