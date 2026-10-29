import type { DiscoveryState } from "./state";

/** Later silences a machine for 7 days. */
export const SILENCE_LATER_S = 7 * 24 * 3600;
export const PROMPTS_PER_HOUR = 3;
export const DISCOVERY_ID = /^[a-z2-7]{26}$/;

export function isSilenced(s: DiscoveryState, id: string, now: number): boolean {
  const v = s.silenced[id];
  return v === "forever" || (typeof v === "number" && v > now);
}

/**
 * One prompt per discovery id per silence period: a machine is offered when first seen, and again once its
 * last prompt is older than a Later silence and it is not silenced (for example after a Later expires).
 */
export function promptDue(s: DiscoveryState, id: string, promptedAt: number | undefined, now: number): boolean {
  return (promptedAt === undefined || promptedAt <= now - SILENCE_LATER_S) && !isSilenced(s, id, now);
}

/** Returns true and records the prompt when one may be shown now. */
export function takePrompt(s: DiscoveryState, now: number): boolean {
  s.prompts = s.prompts.filter(t => t > now - 3600);
  if (s.prompts.length >= PROMPTS_PER_HOUR) return false;
  s.prompts.push(now);
  return true;
}
