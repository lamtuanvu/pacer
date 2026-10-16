import type { AccountCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { hasKey } from "./keys";
import { readEndpointState } from "./state";

/** Safe, shared account.list fields for CLI and app API callers. */
export async function endpointRow(ctx: Ctx, account: AccountCfg) {
  if (!account.connection) return account.kind === "endpoint" ? {state: "external" as const} : {};
  const connection = account.connection;
  const present = await hasKey(ctx, account.name, connection.key);
  const saved = readEndpointState(ctx, account.name);
  return {
    ...saved, state: present ? saved.state : "key_missing" as const,
    connection: {api: connection.api, base_url_host: new URL(connection.base_url).host, key: present ? "present" as const : "missing" as const, models: connection.models},
  };
}
