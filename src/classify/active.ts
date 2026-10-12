import { makeClassifierHooks } from "./classifier-hooks";
import type { DecisionHooks } from "./hooks";

/** The decision hooks pacer uses. */
export const activeHooks: DecisionHooks = makeClassifierHooks();
