/** Actual TypeScript Zod parameter checks for the Rust Orca parity fixtures. */
import { ORCA_CAPABILITY_METHODS } from "../../src/plugins/executor-orca-protocol";

type Input = { mode: "params"; cases: { method: string; params: unknown }[] };
const input = JSON.parse(await Bun.stdin.text()) as Input;
if (input.mode !== "params") throw Error(`unsupported mode: ${String(input.mode)}`);
console.log(JSON.stringify(input.cases.map(c => ORCA_CAPABILITY_METHODS[c.method].params.safeParse(c.params).success)));
