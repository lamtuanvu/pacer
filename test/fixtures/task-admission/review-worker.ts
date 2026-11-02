import { existsSync, writeFileSync } from "node:fs";
import { callOp } from "../../../src/api/ops";
import { toApiError } from "../../../src/api/protocol";

const [home, id, revision, verdict, ready, release] = process.argv.slice(2);
writeFileSync(ready!, "ready");
const until = Date.now() + 10_000;
while (!existsSync(release!) && Date.now() < until) await Bun.sleep(5);
if (!existsSync(release!)) throw new Error("review release timed out");
const result = await callOp({ home: home!, pacerHome: home!, now: Date.now() / 1000, env: {},
  run: async () => ({ code: 127, stdout: "", stderr: "" }), which: () => null },
"task.review", { id, expect_rev: Number(revision), verdict }).catch(toApiError) as { code?: string; data?: { task?: { rev?: number } } };
console.log(JSON.stringify(result.code ? { code: result.code, rev: result.data?.task?.rev } : { ok: true }));
