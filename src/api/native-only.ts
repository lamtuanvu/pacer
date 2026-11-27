import { CoreError } from "../core/errors";

/** Handler for an operation only the Rust front door answers (M3). The op keeps its schema for the protocol docs. */
export function nativeOnly(op: string): () => Promise<never> {
  return async () => {
    throw new CoreError("unavailable", `${op} is answered by the pacer front door`, "Unset PACER_FORWARD_OPS for this operation.");
  };
}