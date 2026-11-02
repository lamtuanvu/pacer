import { startTaskHistory } from "../../src/tasks/history";
import { makeCtx } from "../../src/ctx";

// Report the real child so the test can prove its ownership-pipe lifecycle.
const spawn = Bun.spawn;
Bun.spawn = ((argv: string[], options: unknown) => {
  if (!argv.includes("_task-history")) return (spawn as (...args: any[]) => ReturnType<typeof Bun.spawn>)(argv, options);
  // Complete CLI imports and install the real ownership handler before the
  // parent tells the test to close the pipe. No production readiness seam.
  const script = `import { main } from ${JSON.stringify(new URL("../../src/cli.ts", import.meta.url).pathname)};
    const work = main(['_task-history']); console.log('ready');
    const result = await work; process.exit(result.code);`;
  const child = spawn([process.execPath, "-e", script], { ...(options as object), stdout: "pipe" });
  void child.stdout.getReader().read().then(({ value }) => {
    if (new TextDecoder().decode(value).includes("ready")) console.log(JSON.stringify({ worker: child.pid }));
  });
  return child;
}) as typeof Bun.spawn;
startTaskHistory(makeCtx());
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
