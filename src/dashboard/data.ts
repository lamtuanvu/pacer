import type { ApiClient } from "../api/client";
import type { LinkSnapshot } from "../link/envelope";
import { cards } from "./model";

export async function refreshView(
  client: ApiClient,
  view: { snapshot: LinkSnapshot; selected: number; now: number },
): Promise<{ snapshot: LinkSnapshot; selected: number }> {
  const selectedId = cards(view.snapshot, view.now).flatMap(g => g.cards)[view.selected]?.id;
  const { snapshot } = await client.snapshot();
  const updated = cards(snapshot, view.now).flatMap(g => g.cards);
  const index = updated.findIndex(card => card.id === selectedId);
  return { snapshot, selected: index >= 0 ? index : Math.max(0, Math.min(view.selected, updated.length - 1)) };
}
