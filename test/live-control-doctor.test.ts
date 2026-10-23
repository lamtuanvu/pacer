import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

test("desktop doctor requires successful owned-window setup before reporting readiness", async () => {
  const script = join(tmpDir(), "doctor-probe.ts");
  const directory = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    let setup;
    let alive = true;
    mock.module(${JSON.stringify(join(directory, "desktop.ts"))}, () => ({ nativeCommand: async request => request.command === "permission_setup" ? setup : { accessibility: true, screen_capture: true } }));
    mock.module(${JSON.stringify(join(directory, "lease.ts"))}, () => ({ sameProcess: async () => alive, processIdentity: async () => null, acquireLease: async () => ({ release: async () => {} }) }));
    const { desktopDoctor } = await import(${JSON.stringify(join(directory, "doctor.ts"))});
    const session = { id: "doctor-test", desktopPid: 123, desktopIdentity: { pid: 123, start_identity: "owned" } };
    const results = [];
    for (const value of [{status:"timeout",accessibility:true,target_pid:123},{status:"cancelled",accessibility:true,target_pid:123},{status:"verified",accessibility:false,target_pid:123},{status:"verified",accessibility:true,target_pid:456},{status:"verified",accessibility:true,target_pid:123}]) {
      setup = value; results.push(await desktopDoctor(session, true));
    }
    alive = false; results.push(await desktopDoctor(session, true));
    console.log(JSON.stringify(results));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect({ code: await child.exited, errors }).toEqual({ code: 0, errors: "" });
  const results = JSON.parse(output);
  expect(results.map((result: { verdict: string }) => result.verdict)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "PASS", "UNVERIFIED"]);
});


test("desktop doctor passes bounded helper input diagnostics without changing readiness", async () => {
  const script = join(tmpDir(), "doctor-input-diagnostics.ts");
  const directory = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    const diagnostic = { schema: 1, helper_pid: 321, post_event_access: false, frontmost_pid: 123,
      selected_window_available: true, owned_target_verified: true,
      focused_application: { attribute_status: -25204 }, focused_element: { attribute_status: -25204 } };
    let windows = [{pid:123,window_id:"456",label:"main",client_id:"worker"}];
    const requests = [];
    mock.module(${JSON.stringify(join(directory, "desktop.ts"))}, () => ({ nativeCommand: async request => {
      requests.push(request); return { accessibility: true, screen_capture: true, input_diagnostics: diagnostic };
    }}));
    mock.module(${JSON.stringify(join(directory, "ota-binding.ts"))}, () => ({
      resolveDesktopControlBinding: async () => ({source:"ota",identity:{pid:123,start_identity:"owned"},windows}),
      assertSameControlBinding: () => {},
    }));
    const { desktopDoctor } = await import(${JSON.stringify(join(directory, "doctor.ts"))});
    const results = [];
    results.push(await desktopDoctor({id:"diagnostic-test"}));
    windows = [...windows, {...windows[0]}]; results.push(await desktopDoctor({id:"diagnostic-test"}));
    windows = []; results.push(await desktopDoctor({id:"diagnostic-test"}));
    console.log(JSON.stringify({requests,results,diagnostic}));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
  expect({ code: await child.exited, errors }).toEqual({ code: 0, errors: "" });
  const { requests, results, diagnostic } = JSON.parse(output);
  expect(requests).toEqual([
    {command:"doctor",pid:123,start_identity:"owned",diagnostic_window_id:"456"},
    {command:"doctor",pid:123,start_identity:"owned"},
    {command:"doctor",pid:123,start_identity:"owned"},
  ]);
  expect(results.map((result: {verdict: string}) => result.verdict)).toEqual(["PASS", "PASS", "PASS"]);
  expect(results.map((result: {diagnostics: {input_diagnostics: unknown}}) => result.diagnostics.input_diagnostics)).toEqual([diagnostic, diagnostic, diagnostic]);
});
