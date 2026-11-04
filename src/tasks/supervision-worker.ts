import { makeCtx } from "../ctx";
import { superviseTasks } from "./api";

interface WorkerMessage {
  type: "init";
  pacerHome: string;
  env: Record<string, string>;
}

let stopped = false;
let ctx: ReturnType<typeof makeCtx> | null = null;
let spawnRunner: ((ctx: ReturnType<typeof makeCtx>, taskId: string) => number | undefined) | null = null;

function stoppedFn(): boolean {
  return stopped;
}

async function runSupervisionLoop(): Promise<void> {
  if (!ctx || !spawnRunner) return;

  while (!stopped) {
    // 10s + jitter(0-2000ms). Sleep first: like the service's own supervisor, never
    // sweep while the service is still starting and serving its first snapshots.
    const baseMs = 10_000;
    const jitter = Math.floor(Math.random() * 2000);
    await Bun.sleep(baseMs + jitter);
    if (stopped) break;

    try {
      await superviseTasks(ctx, spawnRunner, stoppedFn);
    } catch (error) {
      if (!stopped) {
        console.error(`pacer: worker supervision failed: ${String(error)}`);
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    ctx = makeCtx({ env: msg.env, pacerHome: msg.pacerHome });
    const { spawnRunner: defaultSpawn } = await import("./api");
    spawnRunner = defaultSpawn;
    await runSupervisionLoop();
  }
};

// Handle parent process exit
process.on("exit", () => {
  stopped = true;
});

process.on("SIGTERM", () => {
  stopped = true;
});

process.on("SIGINT", () => {
  stopped = true;
});