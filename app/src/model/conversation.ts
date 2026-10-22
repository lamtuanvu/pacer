import type { BrowserApi } from "../data/api";

/** Progress hooks change revisions even while a detail view is open. Read at
 * action time; the service still rejects a concurrent change after this read. */
export async function changeConversation(api: Pick<BrowserApi, "call">, id: string, action: "end" | "resume") {
  const current = await api.call<{rev: number}>("task.get", {id});
  return api.call(`session.${action}`, {id, expect_rev: current.rev});
}
