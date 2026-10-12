export const DECISIONS = ["task_kind", "difficulty", "guard", "result_check"] as const;
export type DecisionName = (typeof DECISIONS)[number];

export const ADAPTER_IDS = ["rules", "ollama", "jev"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export type Question =
  | { type: "choice"; id: string; instructions: string; criteria: Record<string, string> }
  | { type: "score"; id: string; instructions: string; min: number; max: number }
  | { type: "yesno"; id: string; instructions: string };

export type Answer = {
  value: string | number | boolean;
  probabilities?: Record<string, number>;
  confidence: number;
  latencyMs: number;
  costUsd?: number;
};

export interface Classifier {
  id: string;
  external: boolean;
  ask(state: string, q: Question): Promise<Answer>;
}

export interface DecisionEntry {
  ts: number;
  id: string;
  decision: DecisionName;
  state_hash: string;
  state: string | null;
  question: Question;
  adapter: string;
  answer: Answer | null;
  acted_on: boolean;
  shadow?: boolean;
  fallback: boolean;
  fallback_from?: string;
  fallback_reason?: string;
  attempted?: Answer;
  error?: string;
  task_id?: string;
}
