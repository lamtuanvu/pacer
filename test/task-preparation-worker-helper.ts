import type { Ctx } from "../src/types";

export function preparationWorker(ctx: Ctx, id: string) {
  const worker = new Worker(new URL("./fixtures/task-preparation-worker.ts", import.meta.url), { type: "module" });
  const messages: { type: string; code?: string }[] = [];
  worker.onmessage = ({ data }) => { messages.push(data); };
  return {
    worker,
    send(type: string) { worker.postMessage({ type, id, ctx: { home: ctx.home, pacerHome: ctx.pacerHome, env: {}, now: ctx.now } }); },
    async wait(type: string) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const message = messages.find(m => m.type === type || m.type === "error");
        if (message) return message;
        await Bun.sleep(10);
      }
      throw new Error(`Worker did not send ${type}`);
    },
  };
}
