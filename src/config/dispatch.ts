import { dispatchConfigSchema, type DispatchConfig } from "../dispatch/types";
import { CoreError } from "../core/errors";

export function parseDispatchConfig(value: unknown): DispatchConfig | undefined {
  if (value === undefined) return undefined;
  const parsed = dispatchConfigSchema.safeParse(value);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid dispatch configuration", undefined, { issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) });
  return parsed.data;
}
