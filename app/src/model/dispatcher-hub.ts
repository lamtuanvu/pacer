import { parse as parseYaml } from "yaml";
import { dispatchConfigSchema, type ModelRecord, type TierTargets } from "../../../src/dispatch/types";
import { TIERS } from "../../../src/dispatch/candidates";
import { fallbackTier } from "../../../src/dispatch/tier-fallback";
import { selectModel } from "../../../src/dispatch/tier-select";
import { executorLabel } from "../../../src/view-model/words";
import type { Rule } from "./executors";
import { difficultyLabels, displayModel, tierLabels } from "./executor-models";
import { DIFFICULTIES, type Difficulty, type RatedTier } from "./tier-targets";

// Pure derivations for Dispatcher › Overview, Who can run what and Profiles: the "Right now" callouts, the
// difficulty strip, the agents table and the profile comparison. Every sentence comes from data the screens
// already read (dispatch.models, runner.models.get, the snapshot's executor readiness, routing.get,
// strategy.list, strategy.preview); nothing here guesses a model's size or calls the service. Where the engine
// decides something (who is ranked, when the planner takes work), the same predicate is used here.

/** One agent as the snapshot describes it: its name and readiness (executorReadiness), when known. */
export interface HubAgent {
  runner: string;
  name: string;
  /** executorReadiness(row): absent while the snapshot does not list the agent. */
  readiness?: { label: string; tone: string; reason: string; availability?: "takes" | "skipped" | "off" | "blocked" };
}

/** Taking work right now: Ready, Not tested or Ahead of pace (an agent the snapshot does not list yet is assumed to). */
export function canTakeWork(agent: Pick<HubAgent, "readiness"> | undefined): boolean {
  const availability = agent?.readiness?.availability;
  return availability === undefined || availability === "takes";
}
/** Ranked by the engine: everything but Off and Cannot take work (a Skipped agent stays an uncertain fallback). */
export function isRankable(agent: Pick<HubAgent, "readiness"> | undefined): boolean {
  const availability = agent?.readiness?.availability;
  return availability !== "off" && availability !== "blocked";
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
const aSize = (tier: RatedTier) => tier === "frontier" ? "a frontier" : `a ${size(tier)}`;
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
  /** Taking work right now (Off, Cannot take work and Skipped are not). */
  canTake: boolean;
  /** In the default list; an agent outside it gets no task without a list of its own. */
  listed: boolean;
  models: HubModel[];
  /** What runs for each difficulty, one cell per difficulty. */
  cells: HubCell[];
  /** Unrated and own-model rows: the one-line explanation shown in the first cell. */
  flat?: { pill: string; tone: "warn" | "neutral" };
  /** An unrated model the user can size on the Agents tab. */
  canRate: boolean;
}
export interface DifficultyTile {
  difficulty: Difficulty;
  target: RatedTier;
  /** Runner ids shown as marks: the agents that take this difficulty now, in order. */
  agents: string[];
  count: string;
  /** Who gets the work and on which model; the reason is said once, in Right now or the size row. */
  who: string;
  planner: boolean;
  nobody: boolean;
  /** Only agents without a sized model (unrated, or picking their own) take it. */
  unsized: boolean;
  /** Only agents whose models are all smaller than the target take it (they run their default). */
  below: boolean;
}
export interface HubAction { label: string; agent?: string; addAgent?: boolean; rules?: boolean }
export interface Summary { headline: string; consequence: string; action?: HubAction; secondary?: HubAction }
export interface OverviewModel {
  rows: OverviewRow[];
  tiles: DifficultyTile[];
  /** Per difficulty: how many agents in the default list (planner left out) declare a model large enough. */
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
  /** Each runner's configured default model (runner.models.get): what it runs below its target. */
  defaults?: Readonly<Record<string, string>>;
  /** The default list (routing.get, the rule without task kinds). Unknown: every agent counts as listed. */
  defaultList?: readonly string[];
}

function behaviorOf(records: readonly ModelRecord[]): AgentBehavior {
  if (!records.some(record => record.binding.kind === "exact")) return "fixed";
  return records.some(record => record.binding.kind === "exact" && record.tier !== "unknown") ? "follow" : "unrated";
}
const modelsOf = (records: readonly ModelRecord[]): HubModel[] => records.flatMap(record => record.binding.kind === "exact"
  ? [{ id: displayModel(record.binding.id), tier: record.tier === "unknown" ? "unknown" as const : record.tier as RatedTier }] : []);

/**
 * The model a delegated task runs on, as the runner selects it (src/tasks/runner.ts: `fixedExecutor`): the smallest
 * declared model at or above the target, else the configured default. `below` marks a choice under the target.
 */
function chosen(records: readonly ModelRecord[], difficulty: Difficulty, targets: TierTargets, defaultModel: string | undefined): { model: string | null; below: boolean; match: boolean } {
  const choice = selectModel([...records], { difficulty, targets, fixedExecutor: true, defaultModel });
  const record = choice.record;
  const model = record?.binding.kind === "exact" ? displayModel(record.binding.id) : defaultModel ? displayModel(defaultModel) : null;
  return { model, below: choice.reason === "executor-fixed-below-target" || choice.reason === "no-eligible", match: choice.reason === "target-match" };
}

/** Everything Dispatcher › Overview shows below its head. */
export function overviewModel(input: OverviewInput): OverviewModel {
  const { records, targets, plannerRunner, fallbackOn } = input;
  const byRunner = new Map<string, ModelRecord[]>();
  for (const record of records) byRunner.set(record.runner, [...(byRunner.get(record.runner) ?? []), record]);
  const agentOf = (runner: string) => input.agents.find(agent => agent.runner === runner);
  const nameOf = (runner: string) => agentOf(runner)?.name ?? executorLabel(runner);
  const listed = (runner: string) => !input.defaultList || input.defaultList.includes(runner);
  const executors = [...byRunner.keys()].filter(runner => runner !== plannerRunner);
  // The engine ranks the default list only (rankExecutors iterates executorsFor), Skipped agents as uncertain fallbacks.
  const ranked = executors.filter(runner => listed(runner) && isRankable(agentOf(runner)));
  const taking = ranked.filter(runner => canTakeWork(agentOf(runner)));
  const plannerRecords = plannerRunner ? byRunner.get(plannerRunner) ?? [] : [];
  const plannerRankable = !!plannerRunner && isRankable(agentOf(plannerRunner));
  // The planner tier fallback (src/engine/rank.ts applyPlannerTierFallback) guards only the tier fallbackTier returns:
  // complex tasks. It applies when no ranked executor declares a model at or above that tier and the planner does.
  const plannerTakes = (difficulty: Difficulty) => {
    const tier = fallbackTier(difficulty, targets);
    return tier !== undefined && fallbackOn && plannerRankable && declares(plannerRecords, tier) && !ranked.some(runner => declares(byRunner.get(runner)!, tier));
  };
  const modelAt = (runner: string, difficulty: Difficulty) => chosen(byRunner.get(runner)!, difficulty, targets, input.defaults?.[runner]);

  const rows: OverviewRow[] = [];
  if (plannerRunner && byRunner.has(plannerRunner)) {
    const behavior = behaviorOf(plannerRecords);
    const row: OverviewRow = { runner: plannerRunner, name: nameOf(plannerRunner), planner: true, behavior, canTake: plannerRankable, listed: true, models: modelsOf(plannerRecords), canRate: behavior === "unrated", cells: [] };
    row.cells = DIFFICULTIES.map(difficulty => {
      const target = targets[difficulty];
      if (plannerTakes(difficulty)) return { difficulty, model: modelAt(plannerRunner, difficulty).model ?? "default model", note: `Fallback: no agent in the default list has ${sizeOrLarger(target)}`, muted: false };
      const why = fallbackTier(difficulty, targets) === undefined ? "the planner fallback covers complex tasks only"
        : !fallbackOn ? "the planner fallback is off"
        : !declares(plannerRecords, target) ? `none of its models is ${size(target)} or larger`
        : !plannerRankable ? "the planner cannot take work now"
        : `an agent in the default list has ${sizeOrLarger(target)}`;
      return { difficulty, model: "—", note: `Not used: ${why}`, muted: true };
    });
    rows.push(row);
  }
  for (const runner of executors) {
    const list = byRunner.get(runner)!, behavior = behaviorOf(list);
    const row: OverviewRow = { runner, name: nameOf(runner), planner: false, behavior, canTake: listed(runner) && canTakeWork(agentOf(runner)), listed: listed(runner), models: modelsOf(list), canRate: behavior === "unrated", cells: [] };
    if (behavior === "follow") {
      row.cells = DIFFICULTIES.map(difficulty => {
        const target = targets[difficulty], pick = modelAt(runner, difficulty);
        if (pick.below) return { difficulty, model: pick.model ?? "default model", note: `Smaller than ${size(target)}: runs its default`, muted: true };
        return { difficulty, model: pick.model ?? "default model", note: pick.match ? "Matches" : "Larger than needed, used when nothing smaller is free", muted: false };
      });
    } else {
      const model = behavior === "unrated" ? modelsOf(list)[0]?.id ?? "" : input.defaults?.[runner] ? displayModel(input.defaults[runner]!) : "Its own choice";
      row.flat = behavior === "unrated" ? { pill: "Unrated", tone: "warn" } : { pill: "Picks its own", tone: "neutral" };
      row.cells = DIFFICULTIES.map((difficulty, index) => ({ difficulty, model, note: index ? "" : "Same for every difficulty", muted: index > 0 }));
    }
    rows.push(row);
  }

  const tiles: DifficultyTile[] = DIFFICULTIES.map(difficulty => {
    const target = targets[difficulty];
    const base = { difficulty, target, planner: false, nobody: false, unsized: false, below: false };
    if (plannerTakes(difficulty)) {
      const model = modelAt(plannerRunner!, difficulty).model;
      return { ...base, agents: [plannerRunner!], count: "Planner", planner: true, who: `${nameOf(plannerRunner!)}${model ? ` on ${model}` : ""}, through the planner fallback` };
    }
    const behavior = (runner: string) => behaviorOf(byRunner.get(runner)!);
    // Who gets the work is who the engine ranks: Skipped agents stay in, as unconfirmed fallbacks after the rest.
    const byTaking = (list: string[]) => [...list.filter(runner => taking.includes(runner)), ...list.filter(runner => !taking.includes(runner))];
    const capable = byTaking(ranked.filter(runner => declares(byRunner.get(runner)!, target)));
    const matching = capable.filter(runner => modelAt(runner, difficulty).match), larger = capable.filter(runner => !matching.includes(runner));
    const unsized = byTaking(ranked.filter(runner => behavior(runner) !== "follow"));
    const below = byTaking(ranked.filter(runner => behavior(runner) === "follow" && !capable.includes(runner)));
    const order = [...matching, ...larger, ...unsized, ...below];
    if (!order.length) return { ...base, agents: [], count: "Nobody", nobody: true, who: "Waits in the queue" };
    const named = (runner: string) => {
      const kind = behavior(runner), pick = modelAt(runner, difficulty), unconfirmed = taking.includes(runner) ? "" : ", unconfirmed";
      if (kind === "fixed") return `${nameOf(runner)} (its own model${unconfirmed})`;
      if (kind === "unrated") return `${nameOf(runner)} (${modelsOf(byRunner.get(runner)!)[0]?.id}, unrated${unconfirmed})`;
      return `${nameOf(runner)} (${pick.model ?? "default model"}${pick.below ? `, smaller than ${size(target)}` : ""}${unconfirmed})`;
    };
    const shown = order.slice(0, 3).map(named), more = order.length - shown.length;
    return { ...base, agents: order, count: capable.length ? agentsWord(capable.length) : agentsWord(order.length),
      unsized: !capable.length && !below.length, below: !capable.length && below.length > 0,
      who: `${shown.join(", ")}${more ? `, and ${more} more` : ""}` };
  });

  const coverage = Object.fromEntries(DIFFICULTIES.map(difficulty => {
    const target = targets[difficulty], count = executors.filter(runner => listed(runner) && declares(byRunner.get(runner)!, target)).length;
    const text = count ? `${agentsWord(count)} in the default list ${plural(count, "has", "have")} ${sizeOrLarger(target)}`
      : plannerRecords.length && declares(plannerRecords, target) ? `Only the planner has ${sizeOrLarger(target)}`
      : `No agent in the default list has ${sizeOrLarger(target)}`;
    return [difficulty, text];
  })) as Record<Difficulty, string>;

  const counts = { all: rows.length, follow: 0, unrated: 0, fixed: 0 };
  for (const row of rows) counts[row.behavior]++;
  return { rows, tiles, coverage, counts, summary: overviewSummary({ rows, tiles, targets, plannerRunner, nameOf, plannerRecords, modelAt }) };
}

function overviewSummary({ rows, tiles, plannerRunner, nameOf, modelAt }: {
  rows: OverviewRow[]; tiles: DifficultyTile[]; targets: TierTargets; plannerRunner: string | null; nameOf: (runner: string) => string; plannerRecords: readonly ModelRecord[];
  modelAt: (runner: string, difficulty: Difficulty) => { model: string | null };
}): Summary {
  const executors = rows.filter(row => !row.planner);
  if (!executors.length) return { headline: "No agent can take delegated work yet.", consequence: "Add an agent so Pacer has someone to hand tasks to.", action: { label: "Add an agent", addAgent: true } };
  // The agent to size a model on: one in the default list that can take work and lists models, else any listed agent.
  const sizeTarget = (executors.find(row => row.canTake && row.behavior !== "fixed") ?? executors.find(row => row.canTake) ?? executors.find(row => row.listed) ?? executors[0]!).runner;
  // The reason (which sizes exist) is stated once, in the size rows; Right now says what happens and what to do.
  const planned = tiles.filter(tile => tile.planner), waiting = tiles.filter(tile => tile.nobody);
  if (planned.length) {
    const tile = planned[0]!, model = modelAt(plannerRunner!, tile.difficulty).model;
    return {
      headline: `${difficultyList(planned.map(item => item.difficulty))} tasks go to the planner.`,
      consequence: `${nameOf(plannerRunner!)} runs them${model ? ` on ${model}` : ""} and spends planner quota. Give an agent in the default list ${sizeOrLarger(tile.target)} to keep the planner free.`,
      action: { label: `Add ${aSize(tile.target)} model`, agent: sizeTarget },
      secondary: { label: "Planner fallback settings", agent: plannerRunner! },
    };
  }
  if (waiting.length) return {
    headline: `${difficultyList(waiting.map(tile => tile.difficulty))} tasks wait in the queue.`,
    consequence: "No agent in the default list can take work right now. They start once one can.",
    action: { label: "Open Who can run what", rules: true },
  };
  const below = tiles.filter(tile => tile.below), unsized = tiles.filter(tile => tile.unsized);
  const follow = executors.some(row => row.behavior === "follow");
  if (below.length) return {
    headline: `${difficultyList(below.map(tile => tile.difficulty))} tasks run on models smaller than they need.`,
    consequence: `Give an agent in the default list ${sizeOrLarger(below[0]!.target)} so they get one.`,
    action: { label: `Add ${aSize(below[0]!.target)} model`, agent: sizeTarget },
  };
  if (unsized.length && follow) return {
    headline: `${difficultyList(unsized.map(tile => tile.difficulty))} tasks run on models without a size.`,
    consequence: `Give an agent in the default list ${sizeOrLarger(unsized[0]!.target)} so difficulty steers these tasks.`,
    action: { label: `Add ${aSize(unsized[0]!.target)} model`, agent: sizeTarget },
  };
  const unrated = executors.filter(row => row.behavior === "unrated"), fixed = executors.filter(row => row.behavior === "fixed");
  if (!follow) {
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
  return {
    headline: "Each difficulty gets a model of the size it needs.",
    consequence: unrated.length
      ? `${joinNames(unrated.map(row => row.name))} ${plural(unrated.length, "runs one model", "run one model each")} for every difficulty until you set ${plural(unrated.length, "its size", "their sizes")}.`
      : "Every agent that lists models has a size for them, so difficulty steers each one.",
    ...(unrated.length ? { action: { label: plural(unrated.length, "Set its size", "Set their sizes"), agent: unrated[0]!.runner } } : {}),
  };
}

// --- Who can run what ---

/** Why an agent is not taking work, in a phrase that follows "is"/"are". */
function blockedPhrase(agent: HubAgent | undefined): string {
  const readiness = agent?.readiness;
  if (readiness?.availability === "off") return "off";
  const reason = readiness?.reason ?? "";
  if (readiness?.availability === "skipped") {
    if (reason === "All parallel slots are in use") return "skipped while all parallel slots are in use";
    if (reason === "Refresh to confirm availability") return "skipped until a refresh confirms it can take work";
    return "skipped until its usage reading is refreshed";
  }
  if (reason === "Out of quota") return "out of quota";
  if (reason === "Sign-in is required") return "signed out";
  if (reason === "No active subscription") return "without a subscription";
  return "unable to take work";
}

/** "Add tse and oc-go", or "Add 4 agents" for a long list. */
export function addLabel(names: readonly string[]): string {
  return names.length <= 3 ? `Add ${joinNames(names)}` : `Add ${names.length} agents`;
}

export interface RulesSummary extends Summary { usable: string[]; add: string[]; skipped: string[] }
/**
 * "Right now" on Who can run what: how many agents in the default list can take work, why the others cannot,
 * where work goes as a result, and agents that could take work but are not listed. The planner is left out: it
 * takes work only through the tier fallback, whatever the list says.
 */
export function rulesSummary({ list: all, agents, available, plannerRunner, repoLists }: {
  /** The default list (the rule without task kinds), in order. */
  list: readonly string[];
  agents: readonly HubAgent[];
  /** Every executor the default list can hold (routing.get `available`). */
  available: readonly string[];
  plannerRunner?: string | null;
  /** Repositories with their own list: their tasks ignore the default list. Undefined while unknown. */
  repoLists?: number;
}): RulesSummary {
  const agentOf = (runner: string) => agents.find(agent => agent.runner === runner);
  const nameOf = (runner: string) => agentOf(runner)?.name ?? executorLabel(runner);
  const list = all.filter(runner => runner !== plannerRunner);
  const usable = list.filter(runner => canTakeWork(agentOf(runner)));
  const blocked = list.filter(runner => !usable.includes(runner));
  const skipped = blocked.filter(runner => agentOf(runner)?.readiness?.availability === "skipped");
  const add = available.filter(runner => runner !== plannerRunner && !list.includes(runner) && !!agentOf(runner) && canTakeWork(agentOf(runner)));
  const where = repoLists === 0 ? "tasks" : "tasks outside repositories with their own list";
  const headline = !list.length ? "The default list is empty."
    : !usable.length ? "No agent in the default list can take work right now."
    : !blocked.length ? (list.length === 1 ? "The one agent in the default list can take work." : `All ${list.length} agents in the default list can take work.`)
    : `Only ${agentsWord(usable.length)} of ${list.length} in the default list can take work.`;
  const groups = new Map<string, string[]>();
  for (const runner of blocked) { const phrase = blockedPhrase(agentOf(runner)); groups.set(phrase, [...(groups.get(phrase) ?? []), nameOf(runner)]); }
  const reasons = [...groups].map(([phrase, names]) => `${joinNames(names)} ${plural(names.length, "is", "are")} ${phrase}`);
  // A Skipped agent is still ranked as an unconfirmed fallback, so work goes there rather than waiting.
  const outcome = !list.length ? `${where} wait in the queue`
    : usable.length ? `${where} go to ${joinNames(usable.map(nameOf))}${usable.length > 1 ? ", in the order Pacer chooses" : ""}`
    : skipped.length ? `${where} go to ${joinNames(skipped.map(nameOf))} as an unconfirmed fallback`
    : `${where} wait in the queue`;
  const sentences = [
    !list.length ? `Add an agent to it, or ${where} wait in the queue.` : reasons.length ? `${joinNames(reasons)}, so ${outcome}.` : `${capitalize(outcome)}.`,
    add.length ? `${joinNames(add.map(nameOf))} can take work but ${plural(add.length, "isn't", "aren't")} in this list.` : "",
  ];
  return { headline, consequence: sentences.filter(Boolean).join(" "), usable, add, skipped, ...(add.length ? { action: { label: addLabel(add.map(nameOf)) } } : {}) };
}

/** "N of M can take work" for a repository's own list. */
export function listAvailability(list: readonly string[], agents: readonly HubAgent[]): { text: string; tone: "good" | "warn" | "bad" } {
  const usable = list.filter(runner => canTakeWork(agents.find(agent => agent.runner === runner))).length;
  return { text: `${usable} of ${list.length} can take work`, tone: !usable ? "bad" : usable < list.length ? "warn" : "good" };
}

/** The default list is the rule without task kinds (routing keeps it last). */
export const defaultRuleIndex = (rules: readonly Rule[]) => rules.findIndex(rule => !rule.kinds);

/** Plain names for the built-in ladder steps, with what each one means. */
export const STEP_COPY: Readonly<Record<string, [string, string]>> = {
  "capable-with-headroom": ["A capable model with spare capacity", "Model size fits the task, and the account has room"],
  "usable-fallback": ["Any usable fallback", "Anyone who can still take work, even with little room left"],
};
export const stepName = (id: string) => STEP_COPY[id]?.[0] ?? id.replaceAll("-", " ").replace(/^\w/, letter => letter.toUpperCase());

// --- Profiles ---

export const POLICY_LABELS: Readonly<Record<string, string>> = { priority: "Priority", even: "Even", "burn-before-reset": "Burn before reset", "cheapest-first": "Cheapest first" };
const policyLabel = (policy: string) => POLICY_LABELS[policy] ?? "Custom";
const sizeWord = (tier: unknown) => tier === "small" || tier === "medium" || tier === "frontier" ? size(tier) : "unrated";

/** The facts of a profile the comparison names, read from the strategy YAML that strategy.preview returns. */
export interface ProfileFacts {
  /** The planner as a runner reference (`claude-code`, or `claude-code#claude1` for the object form). */
  planner: string | null;
  policy: string;
  reserve: number;
  fallback: "on" | "off";
  targets: TierTargets;
  /** The choice method in words: the steps in order and what happens when nobody fits. */
  method: string;
  /** Each runner's declared models (`id (size)`) and default, keyed by its runner reference. */
  models: Record<string, string>;
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Read a profile with a real YAML parser; missing keys take the service defaults. Invalid YAML yields null. */
export function profileFacts(yaml: string): ProfileFacts | null {
  let raw: unknown;
  try { raw = parseYaml(yaml); } catch { return null; }
  const root = isObject(raw) ? raw : {};
  const pacing = isObject(root.pacing) ? root.pacing : {};
  const dispatch = isObject(root.dispatch) ? root.dispatch : {};
  const plannerRaw = root.planner;
  const planner = typeof plannerRaw === "string" && plannerRaw ? plannerRaw
    : isObject(plannerRaw) && typeof plannerRaw.agent === "string" ? `${plannerRaw.agent}${typeof plannerRaw.account === "string" && plannerRaw.account !== plannerRaw.agent ? `#${plannerRaw.account}` : ""}` : null;
  const reserve = Number(pacing.planner_reserve);
  const targetsRaw = isObject(dispatch.tierTargets) ? dispatch.tierTargets : {};
  const tier = (key: Difficulty): TierTargets[Difficulty] => {
    const value = targetsRaw[key];
    return value === "small" || value === "medium" || value === "frontier" ? value : DEFAULT_CONFIG.tierTargets[key];
  };
  const steps = Array.isArray(dispatch.steps) ? dispatch.steps.map(step => isObject(step) && typeof step.id === "string" ? step.id : "step") : DEFAULT_CONFIG.steps.map(step => step.id);
  const onNoMatch = dispatch.onNoMatch === "fail" ? "fail" : dispatch.onNoMatch === "queue" ? "queue" : DEFAULT_CONFIG.onNoMatch;
  const engine = typeof dispatch.engine === "string" && dispatch.engine !== "ladder" ? dispatch.engine : null;
  const method = `${engine ? `Plugin ${engine}; ` : ""}${steps.map(stepName).join(", then ")}; if nobody fits, ${onNoMatch === "fail" ? "reports it" : "waits"}`;
  const models: Record<string, string> = {};
  const runners = isObject(root.runners) ? root.runners : {};
  for (const [id, value] of Object.entries(runners)) {
    if (!isObject(value)) continue;
    const list = Array.isArray(value.models) ? value.models.map(item => isObject(item) && typeof item.id === "string" ? `${displayModel(item.id)} (${sizeWord(item.tier)})` : typeof item === "string" ? displayModel(item) : "").filter(Boolean) : [];
    const fallbackModel = typeof value.model === "string" ? `default ${displayModel(value.model)}` : "";
    const text = [list.join(", "), fallbackModel].filter(Boolean).join("; ");
    if (text) models[id] = text;
  }
  return {
    planner, policy: typeof pacing.policy === "string" ? pacing.policy : "priority",
    reserve: Number.isFinite(reserve) && pacing.planner_reserve !== undefined ? reserve : 15,
    fallback: pacing.planner_tier_fallback === "off" ? "off" : "on",
    targets: { simple: tier("simple"), standard: tier("standard"), complex: tier("complex") },
    method, models,
  };
}
const DEFAULT_CONFIG = dispatchConfigSchema.parse({});

/** The `strategy.preview` answer for a saved profile (`{from: name}`): its YAML, ranking and routing are the `draft` sides. */
export interface ProfilePreview { ok: boolean; errors?: string[]; yaml: string; ranking: { current: string[]; draft: string[] }; routing: { current: Rule[]; draft: Rule[] } }
/** One side of a comparison, all from one `strategy.preview {from: name}` answer. */
export interface ProfileSide { facts: ProfileFacts; ranking: readonly string[]; routing: readonly Rule[] }
export interface ProfileChange { what: string; from: string; to: string }
export interface ProfileComparison { changes: ProfileChange[]; unchanged: string[] }

export function profileSide(preview: ProfilePreview): ProfileSide | null {
  const facts = preview.ok ? profileFacts(preview.yaml) : null;
  return facts ? { facts, ranking: preview.ranking.draft, routing: preview.routing.draft } : null;
}

const defaultList = (rules: readonly Rule[]) => rules.find(rule => !rule.kinds)?.executors ?? [];

/** What switching from the active profile to another changes, row by row, and what stays. */
export function compareProfiles({ active, target, label }: {
  active: ProfileSide; target: ProfileSide;
  /** Display name for a runner or agent id. */
  label: (id: string) => string;
}): ProfileComparison {
  const names = (ids: readonly string[]) => ids.length ? ids.map(label).join(", ") : "Nobody";
  const kindLists = (rules: readonly Rule[]) => rules.filter(rule => rule.kinds?.length).map(rule => `${rule.kinds!.join(", ")}: ${names(rule.executors)}`).join("; ") || "None";
  const sizes = (targets: TierTargets) => DIFFICULTIES.map(difficulty => size(targets[difficulty])).join(", ");
  const a = active.facts, b = target.facts;
  const planner = (facts: ProfileFacts) => facts.planner ? label(facts.planner) : "Not set";
  const facts: { what: string; from: string; to: string; unchanged: string }[] = [
    { what: "Planner", from: planner(a), to: planner(b), unchanged: `the planner (${planner(a)})` },
    { what: "Planner reserve", from: `Keeps ${a.reserve}% back`, to: `Keeps ${b.reserve}% back`, unchanged: `the planner keeps ${a.reserve}% back` },
    { what: "Default list", from: names(defaultList(active.routing)), to: names(defaultList(target.routing)), unchanged: "the default list" },
    { what: "Task-kind lists", from: kindLists(active.routing), to: kindLists(target.routing), unchanged: "the task-kind lists" },
    { what: "Pacing", from: `${policyLabel(a.policy)}: ${names(active.ranking)}`, to: `${policyLabel(b.policy)}: ${names(target.ranking)}`, unchanged: `pacing (${policyLabel(a.policy).toLowerCase()})` },
    { what: "Choice method", from: a.method, to: b.method, unchanged: "the choice method" },
    { what: "Model size for each difficulty", from: sizes(a.targets), to: sizes(b.targets), unchanged: "model sizes for each difficulty" },
    { what: "Planner fallback", from: a.fallback === "on" ? "On" : "Off", to: b.fallback === "on" ? "On" : "Off", unchanged: `the planner fallback (${a.fallback})` },
  ];
  const runners = [...new Set([...Object.keys(a.models), ...Object.keys(b.models)])].sort();
  const modelChanges = runners.filter(id => (a.models[id] ?? "") !== (b.models[id] ?? ""))
    .map(id => ({ what: `${label(id)} models`, from: a.models[id] ?? "None declared", to: b.models[id] ?? "None declared" }));
  return {
    changes: [...facts.filter(fact => fact.from !== fact.to).map(({ what, from, to }) => ({ what, from, to })), ...modelChanges],
    unchanged: [...facts.filter(fact => fact.from === fact.to).map(fact => fact.unchanged), ...(runners.length && !modelChanges.length ? ["each agent's models"] : []), "repository lists"],
  };
}

/** A saved profile's summary (src/strategy/service.ts `summarize`), split into the facts the list shows. */
export interface ProfileRowFacts { first?: string; reserve?: number; policy: string }
/** "Codex (team) first, Claude Code keeps 15%; cheapest-first policy" → First: Codex · team, keeps 15%, Cheapest first. */
export function profileRowFacts(summary: string): ProfileRowFacts | null {
  const match = /^(?:(.+?) first|Configured executors), .+? keeps (\d+(?:\.\d+)?)%(?:; ([a-z-]+) policy)?$/.exec(summary);
  if (!match) return null;
  const first = match[1]?.replace(/^(.+?) \((.+)\)$/, "$1 · $2");
  return { ...(first ? { first } : {}), reserve: Number(match[2]), policy: policyLabel(match[3] ?? "priority") };
}
