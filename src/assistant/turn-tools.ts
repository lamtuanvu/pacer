import type { CardDeps } from "./actions";
import type { Redactor } from "./redact";
import type { ReadOp } from "./tools";
import type { ActionCard, AssistantScope } from "./types";

/**
 * One turn's tool budget: `max` calls are allowed, then `capability.assistant.tool` and the
 * `assistant.tool` op are refused. Every backend's `assistant.reply` call charges one call per
 * round under `limits.maxToolRounds`.
 */
export interface ToolBudget { used: number; max: number }

/** What one turn's tool calls collect, for `finishTurn`: cards, notes, the log and cited tasks. */
export interface AssistantToolState {
  cards: ActionCard[];
  notes: string[];
  toolLog: unknown[];
  seenTasks: Set<string>;
  rounds: ToolBudget;
}

/**
 * The tool context of one in-progress `assistant.reply` call. The registry binds it to that call's
 * `CallAuthority`, so `capability.assistant.tool` is answered only under that authority, for that
 * turnId and within that budget, and never after the call ends.
 */
export interface AssistantToolTurn {
  turnId: string;
  scope: AssistantScope;
  read: ReadOp;
  redactor: Redactor;
  cards: CardDeps;
  state: AssistantToolState;
}

const open = new WeakMap<object, AssistantToolTurn>();

/** Bind a turn's tool context to its reply call's authority. The closer runs when the call ends. */
export function openAssistantTurn(authority: object, turn: AssistantToolTurn): () => void {
  open.set(authority, turn);
  return () => { if (open.get(authority) === turn) open.delete(authority); };
}

/** The turn this authority may run tools for, or null: no call, another call, or a call that ended. */
export function assistantTurnFor(authority: object): AssistantToolTurn | null {
  return open.get(authority) ?? null;
}

/** Whether one of a plugin's live call authorities is answering `turnId`: who may stream `assistant.delta` into it. */
export function answersTurn(authorities: Iterable<object>, turnId: string): boolean {
  for (const authority of authorities) if (open.get(authority)?.turnId === turnId) return true;
  return false;
}

/**
 * The same tool context, addressable by `turnId` for the client op `assistant.tool`, which arrives on
 * another request and so cannot hold the reply call's authority object. Both lookups name one object,
 * so `capability.assistant.tool` and `assistant.tool` charge one shared round budget per turn.
 * The closer runs when the turn ends, so a call after that is refused.
 */
const byTurnId = new Map<string, AssistantToolTurn>();

export function openAssistantTurnFor(turnId: string, turn: AssistantToolTurn): () => void {
  byTurnId.set(turnId, turn);
  return () => { if (byTurnId.get(turnId) === turn) byTurnId.delete(turnId); };
}

/** The turn a `assistant.tool` call may run a tool for, or null: the turn ended, or never ran. */
export function assistantTurnById(turnId: string): AssistantToolTurn | null {
  return byTurnId.get(turnId) ?? null;
}
