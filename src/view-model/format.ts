import { parseRunnerId } from "../config/runner-id";
import { displayName as runnerName, names } from "../render/accounts";
/** Runner ids and known provider ids get their friendly name; anything else is shown as given. */
export const displayName = (id: string) => parseRunnerId(id) || Object.hasOwn(names, id) ? runnerName(id) : id;
export { duration, backIn, ago, elapsed, clock } from "./time";

export { percentage } from "./words";
