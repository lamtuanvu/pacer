// Holds one task's shared lock, reports `locked`, then on `go` changes the task and releases the lock.
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { makeCtx } from "../../src/ctx";
import { updateTask, withTaskLock } from "../../src/tasks/store";

const [pacerHome, id, change, locked, go] = process.argv.slice(2);
const temp = [realpathSync(tmpdir()), "/tmp", "/private/tmp"];
if (!pacerHome || !temp.some(root => realpathSync(pacerHome).startsWith(`${root}/`))) throw Error("pacer home must be a temporary directory");
const ctx = makeCtx({ pacerHome, home: dirname(pacerHome), env: {} });
withTaskLock(ctx, id!, () => {
  writeFileSync(locked!, "");
  while (!existsSync(go!)) Bun.sleepSync(10);
  updateTask(ctx, id!, t => {
    if (change === "run") t.state = "running";
    else if (change === "unlease") delete t.driving;
    else throw Error(`unknown change ${change}`);
  });
});
