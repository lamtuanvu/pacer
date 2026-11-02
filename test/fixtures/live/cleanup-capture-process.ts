import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownProcessIdentity } from "../../../src/update/desktop/process-identity";

const [mode, childRoot, childRole] = process.argv.slice(2);
const root =
  mode === "fixture-child" ? childRoot : dirname(process.env.PACER_HOME!);
const role =
  mode === "fixture-child" ? childRole : mode === "serve" ? "service" : "proxy";
const identity = ownProcessIdentity();
if (!identity) throw Error("Cannot prove controlled fixture process identity");
if (mode === "fixture-child") {
  writeFileSync(
    join(root, `${role}-descendant.json`),
    JSON.stringify(identity),
  );
  setInterval(() => {}, 1000);
} else {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "fixture-child", root, role],
    {
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  const end = Date.now() + 5000;
  while (!existsSync(join(root, `${role}-descendant.json`))) {
    if (Date.now() >= end)
      throw Error("Controlled descendant did not become ready");
    await Bun.sleep(10);
  }
  const descendant = JSON.parse(
    readFileSync(join(root, `${role}-descendant.json`), "utf8"),
  );
  if (descendant.pid !== child.pid)
    throw Error("Controlled descendant identity changed");
  writeFileSync(
    join(root, `${role}-ready.json`),
    JSON.stringify({ leader: identity, descendant }),
  );
  setInterval(() => {}, 1000);
}
