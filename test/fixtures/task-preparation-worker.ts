import { withTaskPreparation, updateTask } from "../../src/tasks/store";
import type { Ctx } from "../../src/types";

let release: (() => void) | undefined;
self.onmessage = async ({ data }) => {
  if (data.type === "release") { release?.(); return; }
  const ctx = data.ctx as Ctx;
  try {
    if (data.type === "mutate") {
      updateTask({ ...ctx, operation: { signal: new AbortController().signal } }, data.id, task => { task.kind = "worker"; });
    } else {
      await withTaskPreparation(ctx, data.id, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
          self.postMessage({ type: "held" });
          if (data.type === "prepare-bounded") setTimeout(resolve, 200);
        });
      }, () => updateTask(ctx, data.id, task => { task.kind = "prepared"; }));
    }
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({ type: "error", code: (error as { code?: string }).code, message: String(error) });
  }
};
