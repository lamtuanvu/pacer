import { loadStrategy } from "../config/strategy";
import { accountListPart } from "../core/accounts";
import { readOrcaAccounts } from "../orca/accounts";
import type { Ctx } from "../types";

/** Per-account reads for native `account.list`; Rust composes and redacts the rows. */
export async function accountListParts(ctx: Ctx) {
  const s = loadStrategy(ctx);
  const orca = await readOrcaAccounts(ctx);
  return {accounts: await Promise.all(Object.values(s.accounts).map(async a => ({name: a.name, ...await accountListPart(ctx, s, orca, a)})))};
}
