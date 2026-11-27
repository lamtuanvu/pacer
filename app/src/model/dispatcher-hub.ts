import type { ModelRecord, TierTargets } from "../../../src/dispatch/types";
import { TIERS } from "../../../src/dispatch/candidates";
import { selectModel } from "../../../src/dispatch/tier-select";
import { executorLabel } from "../../../src/view-model/words";
import type { Rule } from "./executors";
import { difficultyLabels, displayModel, tierLabels } from "./executor-models";
import { DIFFICULTIES, groupPreview, type Difficulty, type RatedTier } from "./tier-targets";

// Pure derivations for Dispatcher › Overview, Who can run what and Profiles: the "Right now" callouts, the
// difficulty strip, the agents table and the profile comparison. Every sentence comes from data the screens
// already read (dispatch.models, the snapshot's executor readiness, routing.get, strategy.preview); nothing here
// guesses a model's size or calls the service.

/** One agent as the snapshot describes it: its name and readiness (executorReadiness), when known. */
export interface HubAgent {
  runner: string;
  name: string;
  /** executorReadiness(row): absent while the snapshot does not list the agent. */
  readiness?: { label: string; tone: string; reason: string };
}

/** Off and Cannot take work leave an agent out of ranking; every other state (Ready, Skipped, Ahead of pace, Not tested) can still be chosen. */
export function canTakeWork(agent: Pick<HubAgent, "readiness"> | undefined): boolean {
  const label = agent?.readiness?.label;
  return label !== "Off" && label !== "Cannot take work";
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
const plural = (count: number, one: string, many: string) => count === 1 ? one : many;
const agentsWord = (count: number) => `${count} ${plural(count, "agent", "agents")}`;
const size = (tier: RatedTier) => tierLabels[tier].toLowerCase();
/** "a small or larger model"; frontier has nothing larger. */
const sizeOrLarger = (tier: RatedTier) => tier === "frontier" ? "a frontier model" : `a ${size(tier)} or larger model`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** "Simple", "Standard and complex". */
const difficultyList = (list: readonly Difficulty[]) => capitalize(joinNames(list.map(difficulty => difficultyLabels[difficulty].toLowerCase())));

const fits = (record: ModelRecord, tier: RatedTier) => record.binding.kind === "exact" && record.tier !== "unknown" && TIERS[record.tier] >= TIERS[tier];
const declares = (records: readonly ModelRecord[], tier: RatedTier) => records.some(record => fits(record, tier));

export type AgentBehavior = "follow" | "unrated" | "fixed";
export interface HubModel { id: string; tier: RatedTier | "unknown" }
export interface HubCell { difficulty: Difficulty; model: string; note: string; muted: boolean }
export interface OverviewRow {
  runner: string;
  name: string;
  planner: boolean;
  behavior: AgentBehavior;
  canTake: boolean;
  models: HubModel[];
  /** Follow rows: what runs for each difficulty. */
  cells?: HubCell[];
  /** Unrated and own-model rows: one line for every difficulty. */
  flat?: { pill: string; tone: "warn" | "neutral"; text: string };
  /** An unrated model the user can size on the Agents tab. */
  canRate: boolean;
}
export interface DifficultyTile {
  difficulty: Difficulty;
  target: RatedTier;
  /** Runner ids shown as marks: the agents that take this difficulty now. */
  agents: string[];
  count: string;
  who: string;
  planner: boolean;
  nobody: boolean;
  /** Only agents without a sized model (unrated, or picking their own) take it. */
  unsized: boolean;
}
export interface HubAction { label: string; agent?: string; addAgent?: boolean }
export interface Summary { headline: string; consequence: string; action?: HubAction; secondary?: HubAction }
export interface OverviewModel {
  rows: OverviewRow[];
  tiles: DifficultyTile[];
  /** Per difficulty: how many agents (planner left out) declare a model large enough, whatever their state. */
  coverage: Record<Difficulty, string>;
  summary: Summary;
  counts: Record<"all" | AgentBehavior, number>;
}
export interface OverviewInput {
  records: readonly ModelRecord[];
  targets: TierTargets;
  agents: readonly HubAgent[];
  plannerRunner: string | null;
  /** pacing.planner_tier_fallback; the service default is on. */
  fallbackOn: boolean;
  /** Each runner's configured default model (runner.models.get), for executors below the target. */
  defaults?: Readonly<Record<string, string>>;
}

function behaviorOf(records: readonly ModelRecord[]): AgentBehavior {
  if (!records.some(record => record.binding.kind === "exact")) return "fixed";
  return records.some(record => record.binding.kind === "exact" && record.tier !== "unknown") ? "follow" : "unrated";
}
const modelsOf = (records: readonly ModelRecord[]): HubModel[] => records.flatMap(record => record.binding.kind === "exact"
  ? [{ id: displayModel(record.binding.id), tier: record.tier === "unknown" ? "unknown" as const : record.tier as RatedTier }] : []);

/** The model a runner would run for a difficulty, as the dispatcher selects it. */
function chosenModel(records: readonly ModelRecord[], difficulty: Difficulty, targets: TierTargets): string | null {
  const record = selectModel([...records], { difficulty, targets }).record;
  return record?.binding.kind === "exact" ? displayModel(record.binding.id) : null;
}

/** Everything Dispatcher › Overview shows below its head. */
export function overviewModel(input: OverviewInput): OverviewModel {
  const { records, targets, plannerRunner, fallbackOn } = input;
  const byRunner = new Map<string, ModelRecord[]>();
  for (const record of records) byRunner.set(record.runner, [...(byRunner.get(record.runner) ?? []), record]);
  const agentOf = (runner: string) => input.agents.find(agent => agent.runner === runner);
  const nameOf = (runner: string) => agentOf(runner)?.name ?? executorLabel(runner);
  const executors = [...byRunner.keys()].filter(runner => runner !== plannerRunner);
  const rankable = executors.filter(runner => canTakeWork(agentOf(runner)));
  const plannerRecords = plannerRunner ? byRunner.get(plannerRunner) ?? [] : [];
  const plannerAvailable = !!plannerRunner && canTakeWork(agentOf(plannerRunner));
  // The planner tier fallback (src/engine/rank.ts): it takes a difficulty only when no rankable executor declares a
  // model at or above the target and one of its own models does.
  const plannerTakes = (difficulty: Difficulty) => {
    const target = targets[difficulty];
    return fallbackOn && plannerAvailable && declares(plannerRecords, target) && !rankable.some(runner => declares(byRunner.get(runner)!, target));
  };
  const grouping = groupPreview(executors.flatMap(runner => byRunner.get(runner)!), targets, input.defaults);

  const rows: OverviewRow[] = [];
  if (plannerRunner && byRunner.has(plannerRunner)) {
    const behavior = behaviorOf(plannerRecords);
    const row: OverviewRow = { runner: plannerRunner, name: nameOf(plannerRunner), planner: true, behavior, canTake: plannerAvailable, models: modelsOf(plannerRecords), canRate: behavior === "unrated" };
    if (behavior === "follow") row.cells = DIFFICULTIES.map(difficulty => {
      const target = targets[difficulty];
      if (plannerTakes(difficulty)) return { difficulty, model: chosenModel(plannerRecords, difficulty, targets) ?? "default model", note: `Fallback: no other agent has ${sizeOrLarger(target)}`, muted: false };
      const why = !fallbackOn ? "the planner fallback is off"
        : !declares(plannerRecords, target) ? `none of its models is ${size(target)} or larger`
        : !plannerAvailable ? "the planner cannot take work now"
        : `another agent has ${sizeOrLarger(target)}`;
      return { difficulty, model: "—", note: `Not used: ${why}`, muted: true };
    });
    else row.flat = { pill: behavior === "unrated" ? "Unrated" : "Picks its own", tone: behavior === "unrated" ? "warn" : "neutral", text: "Takes delegated work only through the planner fallback, which needs a sized model" };
    rows.push(row);
  }
  for (const runner of executors) {
    const list = byRunner.get(runner)!, behavior = behaviorOf(list), canTake = rankable.includes(runner);
    const row: OverviewRow = { runner, name: nameOf(runner), planner: false, behavior, canTake, models: modelsOf(list), canRate: behavior === "unrated" };
    if (behavior === "follow") {
      const follow = grouping.follow.find(item => item.runner === runner)!;
      row.cells = follow.cells.map(cell => cell.skipped
        ? { difficulty: cell.difficulty, model: "Skipped", note: `No ${size(cell.target)} or larger model; runs its default only if picked directly`, muted: true }
        : { difficulty: cell.difficulty, model: cell.chosen ?? "default model", note: cell.note === "Matches the target" ? "Matches" : cell.note, muted: false });
    } else if (behavior === "unrated") {
      const model = grouping.unrated.find(item => item.runner === runner)?.model ?? "";
      row.flat = { pill: "Unrated", tone: "warn", text: `Runs ${model} for every difficulty` };
    } else {
      const fallback = input.defaults?.[runner];
      row.flat = { pill: "Picks its own", tone: "neutral", text: fallback ? `Uses its default model, ${displayModel(fallback)}, for every difficulty` : `${nameOf(runner)} chooses a model itself, so it can take any difficulty` };
    }
    rows.push(row);
  }

  const tiles: DifficultyTile[] = DIFFICULTIES.map(difficulty => {
    const target = targets[difficulty];
    const capable = rankable.filter(runner => declares(byRunner.get(runner)!, target));
    const matching = capable.filter(runner => byRunner.get(runner)!.some(record => record.binding.kind === "exact" && record.tier === target));
    const larger = capable.filter(runner => !matching.includes(runner));
    const unrated = rankable.filter(runner => behaviorOf(byRunner.get(runner)!) === "unrated");
    const fixed = rankable.filter(runner => behaviorOf(byRunner.get(runner)!) === "fixed");
    const also = [
      unrated.length ? `${agentsWord(unrated.length)} with an unrated model also ${plural(unrated.length, "takes", "take")} it.` : "",
      fixed.length ? `${agentsWord(fixed.length)} that ${plural(fixed.length, "picks its", "pick their")} own model also ${plural(fixed.length, "takes", "take")} it.` : "",
    ].filter(Boolean).join(" ");
    if (plannerTakes(difficulty)) {
      const model = chosenModel(plannerRecords, difficulty, targets);
      return { difficulty, target, agents: [plannerRunner!], count: "Planner", planner: true, nobody: false, unsized: false,
        who: `${nameOf(plannerRunner!)}${model ? ` on ${model}` : ""}, through the tier fallback. Uses planner quota.` };
    }
    if (capable.length) {
      const parts = [
        matching.length ? `${joinNames(matching.map(nameOf))} ${plural(matching.length, "matches", "match")}.` : "",
        larger.length ? `${joinNames(larger.map(nameOf))} ${matching.length ? `${plural(larger.length, "steps", "step")} in when nothing smaller is free` : `${plural(larger.length, "has", "have")} only larger models`}.` : "",
        also,
      ];
      return { difficulty, target, agents: [...matching, ...larger], count: agentsWord(capable.length), planner: false, nobody: false, unsized: false, who: parts.filter(Boolean).join(" ") };
    }
    if (unrated.length || fixed.length) return { difficulty, target, agents: [...unrated, ...fixed], count: agentsWord(unrated.length + fixed.length), planner: false, nobody: false, unsized: true,
      who: `No agent that can take work has ${sizeOrLarger(target)}. ${also.replaceAll(" also take", " take")}` };
    return { difficulty, target, agents: [], count: "Nobody", planner: false, nobody: true, unsized: false, who: "No agent can take it now, so these tasks wait in the queue." };
  });

  const coverage = Object.fromEntries(DIFFICULTIES.map(difficulty => {
    const target = targets[difficulty], count = executors.filter(runner => declares(byRunner.get(runner)!, target)).length;
    const text = count ? `${agentsWord(count)} ${plural(count, "has", "have")} ${sizeOrLarger(target)}`
      : plannerRecords.length && declares(plannerRecords, target) ? `Only the planner has ${sizeOrLarger(target)}`
      : `No agent has ${sizeOrLarger(target)}`;
    return [difficulty, text];
  })) as Record<Difficulty, string>;

  const counts = { all: rows.length, follow: 0, unrated: 0, fixed: 0 };
  for (const row of rows) counts[row.behavior]++;
  return { rows, tiles, coverage, counts, summary: overviewSummary({ rows, tiles, targets, plannerRunner, nameOf, plannerRecords }) };
}

function overviewSummary({ rows, tiles, targets, plannerRunner, nameOf, plannerRecords }: {
  rows: OverviewRow[]; tiles: DifficultyTile[]; targets: TierTargets; plannerRunner: string | null; nameOf: (runner: string) => string; plannerRecords: readonly ModelRecord[];
}): Summary {
  const executors = rows.filter(row => !row.planner);
  if (!executors.length) return { headline: "No agent can take delegated work yet.", consequence: "Add an agent so Pacer has someone to hand tasks to.", action: { label: "Add an agent", addAgent: true } };
  // The agent to size a model on: one that can take work and already lists models, else any executor.
  const sizeTarget = (executors.find(row => row.canTake && row.behavior !== "fixed") ?? executors.find(row => row.canTake) ?? executors[0]!).runner;
  const planned = tiles.filter(tile => tile.planner), waiting = tiles.filter(tile => tile.nobody);
  if (planned.length) {
    const lowest = planned[0]!.target, model = plannerRecords.length ? chosenModel(plannerRecords, planned[0]!.difficulty, targets) : null;
    return {
      headline: `${difficultyList(planned.map(tile => tile.difficulty))} tasks go to the planner, because no other agent that can take work has ${sizeOrLarger(lowest)}.`,
      consequence: `${nameOf(plannerRunner!)} runs them${model ? ` on ${model}` : ""} and spends planner quota. Give another agent ${sizeOrLarger(lowest)} to keep the planner free.`,
      action: { label: `Add ${lowest === "frontier" ? "a frontier" : `a ${size(lowest)}`} model`, agent: sizeTarget },
      secondary: { label: "Planner fallback settings", agent: plannerRunner! },
    };
  }
  if (waiting.length) {
    const lowest = waiting[0]!.target;
    return {
      headline: `${difficultyList(waiting.map(tile => tile.difficulty))} tasks wait in the queue, because no agent that can take work has ${sizeOrLarger(lowest)}.`,
      consequence: "They start once one can. Give an agent that can take work a model of that size, or turn one back on.",
      action: { label: `Add ${lowest === "frontier" ? "a frontier" : `a ${size(lowest)}`} model`, agent: sizeTarget },
    };
  }
  const unrated = executors.filter(row => row.behavior === "unrated"), fixed = executors.filter(row => row.behavior === "fixed");
  const unsized = tiles.filter(tile => tile.unsized);
  if (unsized.length && executors.some(row => row.behavior === "follow")) {
    const lowest = unsized[0]!.target;
    return {
      headline: `${difficultyList(unsized.map(tile => tile.difficulty))} tasks go to agents without a sized model, because no agent that can take work has ${sizeOrLarger(lowest)}.`,
      consequence: `They run whatever model those agents use. Give an agent ${sizeOrLarger(lowest)} so difficulty steers these tasks.`,
      action: { label: `Add ${lowest === "frontier" ? "a frontier" : `a ${size(lowest)}`} model`, agent: sizeTarget },
    };
  }
  if (!executors.some(row => row.behavior === "follow")) {
    const parts = [
      unrated.length ? `${agentsWord(unrated.length)} ${plural(unrated.length, "runs a model", "run models")} without a size` : "",
      fixed.length ? `${agentsWord(fixed.length)} ${plural(fixed.length, "picks its", "pick their")} own model` : "",
    ].filter(Boolean);
    return {
      headline: "Every task gets the same model, whatever its difficulty.",
      consequence: `${capitalize(parts.join(", and "))}.${unrated.length ? " Set a size on a model so difficulty can steer it." : ""}`,
      ...(unrated.length ? { action: { label: "Set model sizes", agent: unrated[0]!.runner } } : {}),
    };
  }
  // One clause per distinct size: "Simple tasks run on small models, standard on medium and complex on frontier."
  const clauses = DIFFICULTIES.map((difficulty, index) => `${index ? difficultyLabels[difficulty].toLowerCase() : `${difficultyLabels[difficulty]} tasks run`} on ${size(targets[difficulty])}${index ? "" : " models"}`);
  return {
    headline: `${joinNames(clauses)}.`,
    consequence: unrated.length
      ? `${joinNames(unrated.map(row => row.name))} ${plural(unrated.length, "runs one model", "run one model each")} for every difficulty until you set ${plural(unrated.length, "its size", "their sizes")}.`
      : "Every agent that lists models has a size for them, so difficulty steers each one.",
    ...(unrated.length ? { action: { label: plural(unrated.length, "Set its size", "Set their sizes"), agent: unrated[0]!.runner } } : {}),
  };
}

// --- Who can run what ---

/** Why an agent cannot take work, in a phrase that follows "is"/"are". */
function blockedPhrase(agent: HubAgent | undefined): string {
  const readiness = agent?.readiness;
  if (readiness?.label === "Off") return "off";
  const reason = readiness?.reason ?? "";
  if (reason === "Out of quota") return "out of quota";
  if (reason === "Sign-in is required") return "signed out";
  if (reason === "No active subscription") return "without a subscription";
  return "unable to take work";
}

export interface RulesSummary extends Summary { usable: string[]; add: string[] }
/**
 * "Right now" on Who can run what: how many agents in the default list can take work, why the others cannot,
 * where work goes as a result, and agents that could take work but are not listed.
 */
export function rulesSummary({ list, agents, available, plannerRunner, repoLists = 0 }: {
  /** The default list (the rule without task kinds), in order. */
  list: readonly string[];
  agents: readonly HubAgent[];
  /** Every executor the default list can hold (routing.get `available`). */
  available: readonly string[];
  plannerRunner?: string | null;
  /** Repositories with their own list: their tasks ignore the default list. */
  repoLists?: number;
}): RulesSummary {
  const agentOf = (runner: string) => agents.find(agent => agent.runner === runner);
  const nameOf = (runner: string) => agentOf(runner)?.name ?? executorLabel(runner);
  const usable = list.filter(runner => canTakeWork(agentOf(runner)));
  const blocked = list.filter(runner => !usable.includes(runner));
  const add = available.filter(runner => runner !== plannerRunner && !list.includes(runner) && !!agentOf(runner) && canTakeWork(agentOf(runner)));
  const where = repoLists ? "tasks outside repositories with their own list" : "tasks";
  const headline = !list.length ? "The default list is empty."
    : !usable.length ? `No agent in the default list can take work.`
    : !blocked.length ? (list.length === 1 ? "The one agent in the default list can take work." : `All ${list.length} agents in the default list can take work.`)
    : `Only ${agentsWord(usable.length)} of ${list.length} in the default list can take work.`;
  const groups = new Map<string, string[]>();
  for (const runner of blocked) { const phrase = blockedPhrase(agentOf(runner)); groups.set(phrase, [...(groups.get(phrase) ?? []), nameOf(runner)]); }
  const reasons = [...groups].map(([phrase, names]) => `${joinNames(names)} ${plural(names.length, "is", "are")} ${phrase}`);
  const outcome = !list.length || !usable.length ? `${where} wait in the queue` : `${where} go to ${joinNames(usable.map(nameOf))}${usable.length > 1 ? ", in the order Pacer chooses" : ""}`;
  const sentences = [
    !list.length ? `Add an agent to it, or ${where} wait in the queue.` : reasons.length ? `${capitalize(joinNames(reasons))}, so ${outcome}.` : `${capitalize(outcome)}.`,
    add.length ? `${joinNames(add.map(nameOf))} can take work but ${plural(add.length, "isn't", "aren't")} in this list.` : "",
  ];
  return {
    headline, consequence: sentences.filter(Boolean).join(" "), usable, add,
    ...(add.length ? { action: { label: add.length <= 3 ? `Add ${joinNames(add.map(nameOf))}` : `Add ${add.length} agents` } } : {}),
  };
}

/** "N of M can take work" for a repository's own list. */
export function listAvailability(list: readonly string[], agents: readonly HubAgent[]): { text: string; tone: "good" | "warn" | "bad" } {
  const usable = list.filter(runner => canTakeWork(agents.find(agent => agent.runner === runner))).length;
  return { text: `${usable} of ${list.length} can take work`, tone: !usable ? "bad" : usable < list.length ? "warn" : "good" };
}

/** The default list is the rule without task kinds (routing keeps it last). */
export const defaultRuleIndex = (rules: readonly Rule[]) => rules.findIndex(rule => !rule.kinds);

// --- Profiles ---

export const POLICY_LABELS: Readonly<Record<string, string>> = { priority: "Priority", even: "Even", "burn-before-reset": "Burn before reset", "cheapest-first": "Cheapest first" };
const policyLabel = (policy: string) => POLICY_LABELS[policy] ?? "Custom";

/** The facts of a profile the comparison names, read from the normalized YAML that strategy.preview returns. */
export interface ProfileFacts { planner: string | null; policy: string; reserve: number; fallback: "on" | "off"; targets: TierTargets }
const DEFAULT_TARGETS: TierTargets = { simple: "small", standard: "medium", complex: "frontier" };
const scalar = (text: string | undefined) => text?.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Read the top-level `planner`, the `pacing` scalars and `dispatch.tierTargets` from a strategy as
 * `strategy.preview` serializes it (block style, two-space indent). Missing keys take the service defaults.
 */
export function profileFacts(yaml: string): ProfileFacts {
  const top = new Map<string, string>(), pacing = new Map<string, string>(), targets = new Map<string, string>();
  let section = "", sub = "";
  for (const line of yaml.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^( *)([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line.replace(/\s+$/, ""));
    if (!match) continue;
    const [, indent, key, value] = match, depth = indent!.length;
    if (depth === 0) { section = key!; sub = ""; if (value !== undefined) top.set(key!, value); continue; }
    if (section === "pacing" && depth === 2 && value !== undefined) pacing.set(key!, value);
    if (section === "dispatch" && depth === 2) sub = key!;
    if (section === "dispatch" && sub === "tierTargets" && depth === 4 && value !== undefined) targets.set(key!, value);
  }
  const tier = (key: Difficulty): TierTargets[Difficulty] => {
    const value = scalar(targets.get(key));
    return value === "small" || value === "medium" || value === "frontier" ? value : DEFAULT_TARGETS[key];
  };
  const reserve = Number(scalar(pacing.get("planner_reserve")));
  return {
    planner: scalar(top.get("planner")) || null,
    policy: scalar(pacing.get("policy")) || "priority",
    reserve: Number.isFinite(reserve) && pacing.has("planner_reserve") ? reserve : 15,
    fallback: scalar(pacing.get("planner_tier_fallback")) === "off" ? "off" : "on",
    targets: { simple: tier("simple"), standard: tier("standard"), complex: tier("complex") },
  };
}

/** The `strategy.preview` answer for a saved profile, compared with the active one. */
export interface ProfilePreview { ok: boolean; errors?: string[]; yaml: string; ranking: { current: string[]; draft: string[] }; routing: { current: Rule[]; draft: Rule[] } }
export interface ProfileChange { what: string; from: string; to: string }
export interface ProfileComparison { changes: ProfileChange[]; unchanged: string[] }

const defaultList = (rules: readonly Rule[]) => rules.find(rule => !rule.kinds)?.executors ?? [];
const kindLists = (rules: readonly Rule[]) => rules.filter(rule => rule.kinds?.length).map(rule => `${rule.kinds!.join(", ")}: ${rule.executors.length}`).join("; ");

/** What switching from the active profile to another changes, row by row, and what stays. */
export function compareProfiles({ active, target, preview, label }: {
  active: ProfileFacts; target: ProfileFacts; preview: Pick<ProfilePreview, "ranking" | "routing">;
  /** Display name for a runner or agent id. */
  label: (id: string) => string;
}): ProfileComparison {
  const names = (ids: readonly string[]) => ids.length ? ids.map(label).join(", ") : "Nobody";
  const sizes = (targets: TierTargets) => DIFFICULTIES.map(difficulty => size(targets[difficulty])).join(", ");
  const facts: { what: string; from: string; to: string; unchanged: string }[] = [
    { what: "Planner", from: active.planner ? label(active.planner) : "Not set", to: target.planner ? label(target.planner) : "Not set", unchanged: `the planner (${active.planner ? label(active.planner) : "not set"})` },
    { what: "Planner reserve", from: `Keeps ${active.reserve}% back`, to: `Keeps ${target.reserve}% back`, unchanged: `the planner keeps ${active.reserve}% back` },
    { what: "Default list", from: names(defaultList(preview.routing.current)), to: names(defaultList(preview.routing.draft)), unchanged: "the default list" },
    { what: "Task-kind lists", from: kindLists(preview.routing.current) || "None", to: kindLists(preview.routing.draft) || "None", unchanged: "the task-kind lists" },
    { what: "Pacing", from: `${policyLabel(active.policy)}: ${names(preview.ranking.current)}`, to: `${policyLabel(target.policy)}: ${names(preview.ranking.draft)}`, unchanged: `pacing (${policyLabel(active.policy).toLowerCase()})` },
    { what: "Model size for each difficulty", from: sizes(active.targets), to: sizes(target.targets), unchanged: "model sizes for each difficulty" },
    { what: "Planner fallback", from: active.fallback === "on" ? "On" : "Off", to: target.fallback === "on" ? "On" : "Off", unchanged: `the planner fallback (${active.fallback})` },
  ];
  return {
    changes: facts.filter(fact => fact.from !== fact.to).map(({ what, from, to }) => ({ what, from, to })),
    unchanged: [...facts.filter(fact => fact.from === fact.to).map(fact => fact.unchanged), "repository lists"],
  };
}

/** A saved profile's one-line summary with its policy in plain words ("…; cheapest-first policy" → "… · Cheapest first"). */
export function profileAbout(summary: string): string {
  return summary.replace(/; ([a-z-]+) policy$/, (_, policy: string) => ` · ${policyLabel(policy)}`);
}
