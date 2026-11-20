import { loadStrategySnapshot } from "../config/strategy";
import { accountListPart } from "../core/accounts";
import { computeStatus, type EndpointCell } from "../engine/status";
import { readOrcaAccounts } from "../orca/accounts";
import type { Ctx, UsageReading } from "../types";

/**
 * Per-account reads for native `account.list`, with the strategy text they were read against.
 * Rust parses that same text, so every row comes from one strategy snapshot.
 */
export async function accountListParts(ctx: Ctx) {
  const {path, name, text, strategy: s} = loadStrategySnapshot(ctx);
  // One computation per listing: its readings and endpoint rows feed every account row.
  const readings = new Map<string, UsageReading>();
  const endpoints = new Map<string, EndpointCell>();
  const [orca, status] = await Promise.all([readOrcaAccounts(ctx), computeStatus({...ctx, readOnly: true}, s, {readings, endpoints})]);
  const accounts = await Promise.all(Object.values(s.accounts).map(async a => ({name: a.name, ...await accountListPart(ctx, s, orca, a, status, readings, endpoints)})));
  return {strategy: {path, name, text}, accounts};
}
