import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

test("desktop doctor requires successful owned-window setup before reporting readiness", async () => {
  const script = join(tmpDir(), "doctor-probe.ts");
  const directory = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    let setup;
    mock.module(${JSON.stringify(join(directory, "desktop.ts"))}, () => ({ nativeCommand: async request => request.command === "permission_setup" ? setup : { accessibility: true, screen_capture: true } }));
    mock.module(${JSON.stringify(join(directory, "lease.ts"))}, () => ({ sameProcess: async () => true, acquireLease: async () => ({ release: async () => {} }) }));
    const { desktopDoctor } = await import(${JSON.stringify(join(directory, "doctor.ts"))});
    const session = { id: "doctor-test", desktopIdentity: { pid: 123, start_identity: "owned" } };
    const results = [];
    for (const value of [{status:"timeout",accessibility:true,target_pid:123},{status:"cancelled",accessibility:true,target_pid:123},{status:"verified",accessibility:false,target_pid:123},{status:"verified",accessibility:true,target_pid:456},{status:"verified",accessibility:true,target_pid:123}]) {
      setup = value; results.push(await desktopDoctor(session, true));
    }
    console.log(JSON.stringify(results));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect({ code: await child.exited, errors }).toEqual({ code: 0, errors: "" });
  const results = JSON.parse(output);
  expect(results.map((result: { verdict: string }) => result.verdict)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "PASS"]);
});
