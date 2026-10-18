import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ActionRunner } from "./actions";
export const ActionContext = createContext<ActionRunner>(null!);
export const useActions = () => useContext(ActionContext);
