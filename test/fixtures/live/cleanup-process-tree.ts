import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [mode, root, receipt, delay = "150"] = process.argv.slice(2);
if (mode === "descendant") {
  const write = () => {
    mkdirSync(join(root, "home/orca"), { recursive: true });
    const path = join(root, "home/orca/task-retention.lock");
    writeFileSync(path, "owned fixture");
    try {
      unlinkSync(path);
    } catch {
      /* The failing teardown may race this fixture. */
    }
  };
  write();
  writeFileSync(receipt + ".ready", String(process.pid));
  const timer = setInterval(write, 5);
  process.once("SIGTERM", () => {
    setTimeout(() => {
      clearInterval(timer);
      writeFileSync(receipt, "descendant stopped");
      process.exit(0);
    }, Number(delay));
  });
} else {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "descendant", root, receipt, delay],
    { stdout: "ignore", stderr: "inherit" },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ pid: process.pid }, { headers: { "x-pacer": "1" } }),
  });
  writeFileSync(
    join(root, "ready.json"),
    JSON.stringify({ pid: process.pid, port: server.port, child: child.pid }),
  );
}
