import { withDesktopCoordinator } from "../../../src/update/desktop/coordinator";
import { makeCtx } from "../../../src/ctx";
import { beginWorkSync, claimWorkSync, reserveIdle } from "../../../src/update/desktop/admission";
const [home, mode, lease] = process.argv.slice(2);
const ctx = makeCtx({ home, pacerHome: home, env: {} });
if (mode === "hold") {
  withDesktopCoordinator(ctx, db => {
    db.exec("CREATE TABLE interrupted (value TEXT)");
    console.log("locked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}
else if (mode === "reserve") console.log(JSON.stringify(await reserveIdle(ctx, "worker-tx")));
else if (mode === "claim") {
  claimWorkSync(ctx, lease!); console.log(JSON.stringify({ claimed: true }));
} else {
  try {
    beginWorkSync(ctx, { kind: "launch", id: "worker", label: "Worker" });
    console.log(JSON.stringify({ started: true }));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("maintenance")) throw error;
    console.log(JSON.stringify({ started: false }));
  }
}
