import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, isScalar, Pair, parseDocument, type Node, YAMLMap } from "yaml";
import { isObj } from "../util";
import { atomicStrategyWrite, StrategyDoc } from "./edit";
import { validateStrategy } from "./strategy";

export interface MigrationResult { changed: boolean; backup?: string; summary: string[] }

export function migrateStrategy(path: string): MigrationResult {
  const before = readFileSync(path, "utf8"); const raw = Bun.YAML.parse(before);
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
  const runners = new YAMLMap(yaml.schema);
  for (const pair of accounts.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "";
    const account = strategy.accounts[name]; const runner = strategy.runners[name];
    const original = yaml.getIn(["providers", name], true) as Node;
    let value = pair.value;
    if (!isMap(value)) value = yaml.createNode(isObj(raw) && isObj(raw.providers) && isObj(raw.providers[name]) ? raw.providers[name] : {}, { flow: true });
    if (!isMap(value)) throw Error("cannot create account mapping");
    value.delete("via"); value.delete("model"); value.set("kind", account.kind);
    pair.value = value;
    const run = yaml.createNode({ agent: runner.agent, account: name }, { flow: true }) as YAMLMap;
    if (!isMap(run)) throw Error("cannot create runner mapping");
    if (runner.model !== null) {
      const model = isMap(original) ? original.get("model", true) : undefined;
      run.set("model", isScalar(model) && typeof model.value === "string" ? model.clone() : runner.model);
    }
    runners.items.push(new Pair(yaml.createNode(name), run));
  }
  // Native planners absent from providers still have a default budget account.
  for (const [name, account] of Object.entries(strategy.accounts)) {
    if (!accounts.has(name)) accounts.set(name, yaml.createNode({ kind: account.kind, usage: account.usage }, { flow: true }));
  }
  const doc = new StrategyDoc(before);
  doc.replaceNode(["providers"], accounts);
  doc.renameKey(["providers"], "accounts");
  doc.setIn(["planner"], strategy.planner);
  // Retain the legacy default order, including its OpenCode group shorthand.
  if (!isObj(raw) || !isObj(raw.pacing) || raw.pacing.order === undefined) doc.setList(["pacing", "order"], strategy.pacing.order);
  // Insert runners as a block mapping, rather than rewriting the document.
  doc.setIn(["runners"], {});
  doc.replaceNode(["runners"], runners);
  const after = doc.toString(); validateStrategy(Bun.YAML.parse(after), path);
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
