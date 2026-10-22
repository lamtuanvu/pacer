import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// Real adapter/dispatch/deadline code; synthetic observer and authority collectors.
// No native helper/compiler/application is executed.
test("lazy OTA collection and per-action cancellation cannot deliver late input", async () => {
  const root = tmpDir(), script = join(root, "deadline-probe.ts");
  const control = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    for (const name of ["scripts/live/native", "desktop/native"]) mkdirSync(join(root,name), {recursive:true});
    writeFileSync(join(root,"scripts/live/native/main.swift"),"synthetic observer source");
    writeFileSync(join(root,"desktop/native/permission-chip.swift"),"synthetic permission source");
    mock.module(${JSON.stringify(join(control, "../core.ts"))}, () => ({checkout:root, atomicWrite:(path,bytes)=>writeFileSync(path,bytes)}));
    let calls = 0, inputs = 0, delayFrom = 1, finish, completed = 0, failInput = false;
    let gate = new Promise(resolve => finish = resolve);
    const binding = { source:"ota", identity:{pid:123,start_identity:"owned"}, appSha256:"a".repeat(64), version:"0.2.4",
      transactionId:"tx",installationId:"installation",windows:[{pid:123,window_id:"456",label:"main",client_id:"client"}] };
    mock.module(${JSON.stringify(join(control, "ota-binding.ts"))}, () => ({
      resolveDesktopControlBinding:async()=>{calls++;if(calls>=delayFrom){await gate;completed++;}return binding;},
      assertSameControlBinding:()=>{},
    }));
    const output = value => new Response(JSON.stringify(value)).body;
    Bun.spawn = (argv, options) => {
      if (argv[0] === "/usr/bin/swiftc") writeFileSync(argv.at(-1),"synthetic observer bytes");
      if (argv[0].endsWith("pacer-native-control")) {
        const request = JSON.parse(new TextDecoder().decode(options.stdin));
        const result = request.command === "targets" ? {windows:[{window_id:"456",title:"fixture",bounds:{X:0,Y:0,Width:100,Height:100}}]} :
          request.command === "inspect" ? {elements:[],truncated:false} : {delivery:"delivered"};
        if (request.command === "act") inputs++;
        return {stdout:output({ok:true,result}),stderr:output(""),exited:request.command === "act" && failInput ? Bun.sleep(60).then(()=>1) : Promise.resolve(0),kill:()=>{}};
      }
      return {stdout:output(""),stderr:output(""),exited:Promise.resolve(0),kill:()=>{}};
    };
    const { createDesktopAdapter } = await import(${JSON.stringify(join(control, "desktop.ts"))});
    const { dispatch } = await import(${JSON.stringify(join(control, "dispatch.ts"))});
    // Release only if the old constructor incorrectly attempts collection.
    const creating = createDesktopAdapter({});
    const initial = await Promise.race([creating.then(adapter=>({adapter})),Bun.sleep(100).then(()=>null)]);
    const lazy = calls === 0 && initial !== null;
    if (!initial) finish();
    const adapter = await creating;
    const results = [lazy];
    calls = 0; completed = 0; gate = new Promise(resolve=>finish=resolve);
    const pending = dispatch({command:"act",surface:"desktop",target:"main",action:{kind:"key",key:"ENTER"},timeout_ms:10},adapter);
    const early = await Promise.race([pending,Bun.sleep(100).then(()=>null)]);
    results.push(early?.error?.code === "command_timeout" && completed === 0 && inputs === 0);
    finish(); await pending; await Bun.sleep(5); results.push(inputs === 0);
    // Now permit targets/initial inspection but delay authority during act preflight.
    calls = 0; completed = 0; delayFrom = Infinity; gate = new Promise(resolve=>finish=resolve);
    const current = await createDesktopAdapter({});
    delayFrom = calls + 3;
    const action = dispatch({command:"act",surface:"desktop",target:"main",action:{kind:"key",key:"ENTER"},timeout_ms:20},current);
    const returned = await Promise.race([action,Bun.sleep(150).then(()=>null)]);
    results.push(returned?.error?.code === "command_timeout" && completed === 0 && inputs === 0 && calls === delayFrom);
    finish(); await action; await Bun.sleep(5); results.push(inputs === 0);
    // An input refusal starts diagnostic capture before the original deadline.
    // Dispatch closes its original timer; capture must not inherit a fresh budget.
    calls = 0; completed = 0; inputs = 0; delayFrom = 5; failInput = true;
    gate = new Promise(resolve=>finish=resolve);
    const diagnosticAdapter = await createDesktopAdapter({});
    const diagnostic = dispatch({command:"act",surface:"desktop",target:"main",action:{kind:"key",key:"ENTER"},timeout_ms:100},diagnosticAdapter);
    const diagnosticEarly = await Promise.race([diagnostic,Bun.sleep(130).then(()=>null)]);
    results.push(diagnosticEarly?.error?.code === "observer_unavailable" && completed === 0 && inputs === 1 && calls === 5);
    finish(); await diagnostic; await Bun.sleep(5); results.push(inputs === 1);
    console.log(JSON.stringify(results));
  `);
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual(Array(7).fill(true));
});

test("normal desktop doctor returns at its collection deadline", async () => {
  const root = tmpDir(), script = join(root, "doctor-deadline.ts");
  const control = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    let finish, completed = false, nativeCalls = 0;
    const gate = new Promise(resolve=>finish=resolve);
    mock.module(${JSON.stringify(join(control, "ota-binding.ts"))},()=>({resolveDesktopControlBinding:async()=>{await gate;completed=true;return {identity:{pid:123,start_identity:"owned"}};},assertSameControlBinding:()=>{}}));
    mock.module(${JSON.stringify(join(control, "desktop.ts"))},()=>({nativeCommand:async()=>{nativeCalls++;return {accessibility:true,screen_capture:true};}}));
    const { desktopDoctor } = await import(${JSON.stringify(join(control, "doctor.ts"))});
    const pending = desktopDoctor({},false,10);
    const early = await Promise.race([pending,Bun.sleep(100).then(()=>null)]);
    const bounded = early?.error?.code === "command_timeout" && !completed && nativeCalls === 0;
    finish(); await pending; await Bun.sleep(5);
    console.log(JSON.stringify([bounded,nativeCalls===0]));
  `);
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual([true, true]);
});
