import type { CardDeps } from "./actions";
import type { Redactor } from "./redact";
import type { ReadOp } from "./tools";
import type { ActionCard, AssistantScope } from "./types";

/**
 * One turn's tool budget: `max` calls are allowed, then `capability.assistant.tool` is refused.
 * The `assistant.respond` loop charges its rounds as `maxToolRounds × the four calls each round
 * may ask for`, which its own caps already hold; the capability path charges one call per round.
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
