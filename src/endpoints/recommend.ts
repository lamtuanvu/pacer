import type { CatalogModel, CatalogProvider } from "./catalog";

export interface ModelChoice { id: string; name?: string; context: number; output: number; tools: boolean; costIn: number | null; costOut: number | null }
export type UsageClass = { usage: "quota" | "metered" | "unmetered"; quota_source?: "arkcli"; known: boolean };

const NOT_CHAT = /(embed|image|tts|whisper|vision|rerank|moderation|speech|audio|video)/i;
const CODING = /(coder|codestral|devstral|code)/i;

export function usableModels(models: CatalogModel[]): CatalogModel[] {
  return models.filter(m => m.toolCall && m.input.includes("text") && m.output.length > 0 && m.output.every(o => o === "text"));
}
export function filterModelIds(ids: string[]): string[] {
  return ids.filter(id => !NOT_CHAT.test(id));
}
export function toChoice(m: CatalogModel): ModelChoice {
  return { id: m.id, name: m.name, context: m.context ?? 128000, output: m.outputLimit ?? 16000, tools: true, costIn: m.costIn, costOut: m.costOut };
}
export function idChoice(id: string): ModelChoice {
  return { id, context: 128000, output: 16000, tools: true, costIn: null, costOut: null };
}
export function recommend(models: ModelChoice[], release: Record<string, string | null> = {}): { pick: ModelChoice | null; rest: ModelChoice[] } {
  const score = (m: ModelChoice) => [CODING.test(m.id) || CODING.test(m.name ?? "") ? 1 : 0, m.context, release[m.id] ?? ""] as const;
  const sorted = [...models].sort((a, b) => {
    const [ca, xa, ra] = score(a), [cb, xb, rb] = score(b);
    return cb - ca || xb - xa || rb.localeCompare(ra) || a.id.localeCompare(b.id);
  });
  return { pick: sorted[0] ?? null, rest: sorted.slice(1) };
}
/** arkcli reads BytePlus/Volcengine Ark quota; other plans have no reader yet. */
export function classify(provider: { id: string; local?: boolean }, catalog?: CatalogProvider): UsageClass {
  if (provider.local) return { usage: "unmetered", known: true };
  if (/-coding-plan$/.test(provider.id)) return { usage: "quota", ...(/^(volcengine|byteplus)/.test(provider.id) ? { quota_source: "arkcli" as const } : {}), known: true };
  if (!catalog) return { usage: "metered", known: false };
  const priced = catalog.models.filter(m => m.costIn !== null || m.costOut !== null);
  if (!priced.length) return { usage: "metered", known: false };
  if (priced.every(m => !m.costIn && !m.costOut)) return { usage: "quota", known: true };
  return { usage: "metered", known: true };
}
