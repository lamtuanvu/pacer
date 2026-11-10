import { loadStrategySnapshot } from "../config/strategy";
import { accountListPart } from "../core/accounts";
import { readOrcaAccounts } from "../orca/accounts";
import type { Ctx } from "../types";

/**
 * Per-account reads for native `account.list`, with the strategy text they were read against.
 * Rust parses that same text, so every row comes from one strategy snapshot.
 */
export async function accountListParts(ctx: Ctx) {
  const {path, name, text, strategy: s} = loadStrategySnapshot(ctx);
  const orca = await readOrcaAccounts(ctx);
  const accounts = await Promise.all(Object.values(s.accounts).map(async a => ({name: a.name, ...await accountListPart(ctx, s, orca, a)})));
  return {strategy: {path, name, text}, accounts};
}
