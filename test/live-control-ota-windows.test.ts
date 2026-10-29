import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// Real adapter/dispatch selection; fixed synthetic native observer. No OS control,
// compiler, signer, capture worker or authority collector is actually invoked.
test("a hidden registered tray does not poison an authorized visible OTA main window", async () => {
  const root = tmpDir(), script = join(root, "ota-windows.ts");
  const control = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    // Model the Darwin observer in this disposable child on every CI host. Every
    // compiler/signing/native spawn below is substituted; no Darwin API is used.
    Object.defineProperty(process,"platform",{value:"darwin"});
    const root = ${JSON.stringify(root)};
    for (const dir of ["scripts/live/native","desktop/native"]) mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,"scripts/live/native/main.swift"),"synthetic native observer");
    writeFileSync(join(root,"desktop/native/permission-chip.swift"),"synthetic permission observer");
    mock.module(${JSON.stringify(join(control,"../core.ts"))},()=>({checkout:root,atomicWrite:(path,bytes)=>writeFileSync(path,bytes)}));
    const registrations = [
      {pid:123,window_id:"456",label:"main",client_id:"worker"},
      {pid:123,window_id:"789",label:"tray",client_id:"worker"},
    ];
    let registered = registrations;
    const binding = () => ({source:"ota",identity:{pid:123,start_identity:"owned"},appSha256:"a".repeat(64),version:"0.2.4",transactionId:"tx",installationId:"installation",windows:registered});
    mock.module(${JSON.stringify(join(control,"ota-binding.ts"))},()=>({resolveDesktopControlBinding:async()=>binding(),assertSameControlBinding:()=>{}}));
    let visible = ["456"];
    const stream = value => new Response(JSON.stringify(value)).body;
    Bun.spawn = (argv,options) => {
      if (argv[0] === "/usr/bin/swiftc") writeFileSync(argv.at(-1),"synthetic observer");
      if (argv[0].endsWith("pacer-native-control")) {
        const request = JSON.parse(new TextDecoder().decode(options.stdin));
        if (!["targets","inspect"].includes(request.command)) throw Error("fixture refuses native input");
        const result = request.command === "targets" ? {windows:visible.map(window_id=>({window_id,title:"fixture",bounds:{X:0,Y:0,Width:100,Height:100}}))} : {elements:[],truncated:false};
        return {stdout:stream({ok:true,result}),stderr:stream(""),exited:Promise.resolve(0),kill:()=>{}};
      }
      if (!["/usr/bin/swiftc","/usr/bin/codesign"].includes(argv[0])) throw Error("unexpected fixture spawn");
      return {stdout:stream(""),stderr:stream(""),exited:Promise.resolve(0),kill:()=>{}};
    };
    const { createDesktopAdapter } = await import(${JSON.stringify(join(control,"desktop.ts"))});
    const { dispatch } = await import(${JSON.stringify(join(control,"dispatch.ts"))});
    const results = [];
    const main = await (await createDesktopAdapter({})).targets();
    results.push(main.length === 1 && main[0].id === "main" && main[0].window_id === "456" && main[0].client_id === "worker");
    const inspect = await dispatch({command:"inspect",surface:"desktop",target:"main",timeout_ms:1000},await createDesktopAdapter({}));
    results.push(inspect.outcome === "ok" && inspect.target?.id === "main");
    // Missing requested tray remains unavailable; it is never replaced by main.
    const tray = await dispatch({command:"inspect",surface:"desktop",target:"tray",timeout_ms:1000},await createDesktopAdapter({}));
    results.push(tray.error?.code === "target_unavailable");
    visible = ["789"];
    const missingMain = await dispatch({command:"inspect",surface:"desktop",target:"main",timeout_ms:1000},await createDesktopAdapter({}));
    results.push(missingMain.error?.code === "target_unavailable");
    visible = ["456","999"];
    const intersection = await (await createDesktopAdapter({})).targets();
    results.push(intersection.length === 1 && intersection[0].window_id === "456");
    for (const windows of [[],["999"]]) {
      visible = windows; let refused = false;
      try { await (await createDesktopAdapter({})).targets(); } catch { refused = true; }
      results.push(refused);
    }
    visible = ["456"]; registered = [registrations[0],{...registrations[0]}];
    let ambiguous = false;
    try { await (await createDesktopAdapter({})).targets(); } catch { ambiguous = true; }
    results.push(ambiguous);
    console.log(JSON.stringify(results));
  `);
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual(Array(8).fill(true));
});
