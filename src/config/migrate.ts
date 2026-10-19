import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, isScalar, parseDocument, type Node, YAMLMap } from "yaml";
import { isObj } from "../util";
import { atomicStrategyWrite, StrategyDoc } from "./edit";
import { formatRunnerId, resolveRunner, runnerDefaults } from "./runner-id";
import { validateStrategy } from "./strategy";

export interface MigrationResult { changed: boolean; backup?: string; summary: string[] }

export function migrateStrategy(path: string, expected?: string): MigrationResult {
  const before = readFileSync(path, "utf8");
  if (expected !== undefined && before !== expected) throw Error("strategy changed during migration; retry");
  const raw = Bun.YAML.parse(before);
  const strategy = validateStrategy(raw, path);
  if (!strategy.legacy) return { changed: false, summary: [] };
  const yaml = parseDocument(before);
  if (yaml.errors.length) throw yaml.errors[0];
  const providers = yaml.get("providers", true);
  if (!isMap(providers)) throw Error("providers must be a mapping");
  const accounts = providers.clone() as YAMLMap;
  // These leading comments precede the collection's source range, so the
  // source edit already retains them. Avoid emitting a second copy.
  accounts.commentBefore = undefined;
  for (const pair of accounts.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "";
    const account = strategy.accounts[name];
    let value = pair.value;
    if (!isMap(value)) value = yaml.createNode(isObj(raw) && isObj(raw.providers) && isObj(raw.providers[name]) ? raw.providers[name] : {}, { flow: true });
    if (!isMap(value)) throw Error("cannot create account mapping");
    value.delete("via"); value.set("kind", account.kind);
    if (account.model !== null && !value.has("model")) value.set("model", account.model);
    pair.value = value;
  }
  // Native planners absent from providers still have a default budget account.
  for (const [name, account] of Object.entries(strategy.accounts)) {
    if (!accounts.has(name)) accounts.set(name, yaml.createNode({ kind: account.kind, usage: account.usage }, { flow: true }));
  }
  const doc = new StrategyDoc(before);
  doc.replaceNode(["providers"], accounts);
  doc.renameKey(["providers"], "accounts");
  const plannerId = strategy.planner.agent === "opencode" && !strategy.accounts[strategy.planner.account] ? "opencode" : formatRunnerId({...strategy.planner, host: null}, {...runnerDefaults(strategy.accounts), opencode: undefined});
  doc.setIn(["planner"], plannerId);
  // Retain the legacy default order, including its OpenCode group shorthand.
  if (!isObj(raw) || !isObj(raw.pacing) || raw.pacing.order === undefined) doc.setList(["pacing", "order"], strategy.pacing.order);
  if (isObj(raw) && raw.routing === undefined) doc.setIn(["routing"], strategy.routing.map(r => r.kinds ? {kinds: r.kinds, executors: r.executors} : {default: r.executors}));
  // Rewrite only the referenced ids; retain the OpenCode group shorthand.
  const canonical = (id: unknown) => resolveRunner(strategy, String(id))?.id ?? String(id);
  if (isObj(raw) && isObj(raw.pacing) && Array.isArray(raw.pacing.order)) {
    raw.pacing.order.forEach((id, i) => { if (id !== "opencode" && canonical(id) !== id) doc.setScalar(["pacing", "order", i], canonical(id)); });
  }
  if (isObj(raw) && Array.isArray(raw.routing)) raw.routing.forEach((rule, i) => {
    if (!isObj(rule)) return;
    const key = Array.isArray(rule.default) ? "default" : "executors";
    const refs = rule[key];
    if (Array.isArray(refs)) refs.forEach((id, j) => { if (canonical(id) !== id) doc.setScalar(["routing", i, key, j], canonical(id)); });
  });
  // Every legacy provider existed as a runner even if omitted from explicit routing.
  // Preserve such runners with empty entries; referenced runners need no section.
  const referenced = new Set(strategy.routing.flatMap(r => r.executors));
  referenced.add(plannerId);
  const unreferenced = Object.keys(strategy.runners).filter(id => !referenced.has(id));
  if (unreferenced.length) doc.setIn(["runners"], Object.fromEntries(unreferenced.map(id => [id, {}])));
  let after = doc.toString();
  after = after.replace(/[ \t]+(?=\r?$)/gm, "");
  validateStrategy(Bun.YAML.parse(after), path);
  const backup = `${path}.pre-accounts.bak`;
  if (existsSync(backup)) {
    if (readFileSync(backup, "utf8") !== before) throw Error(`migration backup already exists: ${backup}; preserve or move it before retrying`);
  } else writeFileSync(backup, before, { flag: "wx", mode: 0o600 });
  if (readFileSync(path, "utf8") !== before) throw Error("strategy changed during migration; retry");
  atomicStrategyWrite(path, after);
  return { changed: true, backup, summary: [
    `Migrated providers to ${Object.keys(strategy.accounts).length} accounts and ${Object.keys(strategy.runners).length} runners.`,
    `Planner: ${strategy.planner.agent} on ${strategy.planner.account}; pacing order and routing preserved.`,
  ] };
}

export function migrationLines(path: string, result: MigrationResult): string[] {
  const shQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return result.changed ? [...result.summary, `Backup: ${result.backup}`, `Restore: cp ${shQuote(result.backup!)} ${shQuote(path)}`] : [];
}
