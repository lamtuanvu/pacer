import { strategyPath } from "../config/strategy";
import { migrateStrategy, migrationLines } from "../config/migrate";
import * as config from "../core/config";
import { backendAvailable } from "../exec/backend";
import type { Ctx } from "../types";
import type { Result } from "./types";
import { commandArgs } from "./accounts";

export { CONFIG_KEYS, type ConfigKey } from "../core/config";

export async function configCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    const [verb, ...rest] = args;
    const {pos, flags} = commandArgs(rest, [], verb === 'get' ? ['json'] : []);
    const path = strategyPath(ctx);
    if (verb === 'migrate' && !pos.length) {
      const result = migrateStrategy(path);
      return {code:0,out:result.changed?migrationLines(path,result).join('\n'):'Strategy already uses accounts and runners; nothing changed.',err:''};
    }
    const entries = config.get(ctx).keys;
    if (verb === 'get' && pos.length <= 1) {
      if (pos[0] && !(config.CONFIG_KEYS as readonly string[]).includes(pos[0])) throw Error(`unknown config key: ${pos[0]}`);
      const result = pos[0] ? entries[pos[0]] : entries;
      return {code:0,out:flags.json?JSON.stringify(result,null,2):(pos[0]?[`${pos[0]}: ${JSON.stringify(result.value)} (${result.source})`]:Object.entries(entries).map(([key,v])=>`${key}: ${JSON.stringify(v.value)} (${v.source})`)).join('\n'),err:''};
    }
    if (verb === 'set' && pos.length === 2) {
      const r = await config.set(ctx, pos[0], pos[1], {integrations: 'install', backendReady: backendAvailable});
      return {code:0,out:[`${r.key}: ${JSON.stringify(r.previous)} → ${JSON.stringify(r.value)}`,r.diff,...r.notes,`Undo: ${r.undo}`].filter(Boolean).join('\n'),err:''};
    }
    throw Error('usage: pacer config get [key] [--json] | set <key> <value> | migrate');
  } catch(e) {return {code:2,out:'',err:`pacer: ${e instanceof Error?e.message:String(e)}`};}
}
