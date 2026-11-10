import { backgroundWorkerEntryURL, supervisionWorkerEntryURL } from "../../src/serve/worker-location";

const timer = setTimeout(() => { console.error("WORKER_TIMEOUT"); process.exit(1); }, 20000);
const workers = [
  ["BACKGROUND", backgroundWorkerEntryURL(import.meta.url)],
  ["SUPERVISION", supervisionWorkerEntryURL(import.meta.url)],
] as const;
await Promise.all(workers.map(([name, url]) => new Promise<void>((resolve, reject) => {
  const worker = new Worker(url, { type: "module" });
  worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
    if (event.data.type === "heartbeat") {
      console.log(name + "_HEARTBEAT_OK");
      worker.terminate();
      resolve();
    }
    if (event.data.type === "failed") reject(new Error(String(event.data.reason)));
  };
  worker.onerror = event => reject(new Error(event.message));
  worker.postMessage({ type: "init", pacerHome: process.env.PACER_HOME, env: {},
    selfCommand: [process.execPath], pumpMs: 0 });
})));
clearTimeout(timer);
