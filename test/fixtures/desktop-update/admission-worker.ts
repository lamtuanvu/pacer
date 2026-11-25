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
}
else if (mode === "count") {
  // Bump a `counter` field inside the raw admission row under the coordinator.
  // Mirrors the native two-process race test; `lease` carries the iteration
  // count. The counter is not part of the strict state schema, so it is
  // read and written as raw JSON (never re-serialized through `ensureAdmission`).
  const times = Number(lease || "0");
  for (let i = 0; i < times; i++) {
    withDesktopCoordinator(ctx, db => {
      const row = db.query("SELECT state FROM admission WHERE id = 1").get() as { state: string } | undefined;
      if (!row) throw new Error("missing admission row");
      const state = JSON.parse(row.state);
      state.counter = (state.counter || 0) + 1;
      db.query("UPDATE admission SET state = ? WHERE id = 1").run(JSON.stringify(state));
      return undefined;
    });
  }
  console.log("done");
} else {
  try {
    beginWorkSync(ctx, { kind: "launch", id: "worker", label: "Worker" });
    console.log(JSON.stringify({ started: true }));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("maintenance")) throw error;
    console.log(JSON.stringify({ started: false }));
  }
}
