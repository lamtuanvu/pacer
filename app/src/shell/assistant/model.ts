import type { ActionCard, AssistantScope, TurnView } from "../../../../src/assistant/types";

export interface ScopeChoice { value: string; label: string; scope: AssistantScope }

/** The context chip's choices. "This task" and "This repository" appear only where the app has one in view. */
export function scopeChoices(o: { taskId?: string | null; repo?: string | null; repoLabel?: string | null }): ScopeChoice[] {
  const choices: ScopeChoice[] = [{ value: "dispatch", label: "Dispatch · 7 days", scope: { kind: "dispatch", days: 7 } }];
  if (o.taskId) choices.unshift({ value: "task", label: "This task", scope: { kind: "task", id: o.taskId } });
  if (o.repo) choices.push({ value: "repo", label: o.repoLabel ? `Repository · ${o.repoLabel}` : "This repository", scope: { kind: "repo", repo: o.repo } });
  return choices;
}

/** Opening from a task selects "This task". Otherwise keep the user's last choice if it still applies. */
export function defaultScope(choices: ScopeChoice[], previous?: string): string {
  return choices.find(c => c.value === "task")?.value ?? choices.find(c => c.value === previous)?.value ?? "dispatch";
}

export type StreamFrame = { delta: string } | { status: string } | { done: { state: TurnView["state"]; error?: string } };

/** Parses `data:` lines of the per-turn SSE stream. Incomplete trailing text is returned for the next chunk. */
export function parseFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const frames: StreamFrame[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find(l => l.startsWith("data:"));
    if (!line) continue;
    try {
      const value = JSON.parse(line.slice(5).trim()) as unknown;
      if (value && typeof value === "object") frames.push(value as StreamFrame);
    } catch { /* a malformed frame is ignored; the final turn is read from the service */ }
  }
  return { frames, rest };
}

/** Editable card fields override the proposed params. An empty optional field is left out. */
export function cardParams(card: ActionCard, edits: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...card.params };
  for (const field of card.editable) {
    const value = (edits[field.name] ?? field.value).trim();
    if (value) params[field.name] = value; else if (field.name === "feedback" || field.name === "reason") delete params[field.name];
  }
  return params;
}

/** Plain words for a failed card, never a code. */
export function cardFailure(error: { code?: string; message?: string }): { state: "stale" | "failed"; message: string } {
  if (error.code === "conflict") return { state: "stale", message: "This changed after the assistant suggested it. Refresh the card to use the current state." };
  if (error.code === "not_allowed") return { state: "failed", message: error.message ?? "That is not allowed right now." };
  return { state: "failed", message: error.message ?? "That did not work. Try again from the task page." };
}

export function requestId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
