import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// A structured failure after activation/AXRaise must not become a no-effect
// claim. Only the helper's explicit pre-effect receipt can prove not_delivered.
test("native command preserves uncertain action failures and never retries them", async () => {
  const root = tmpDir(), script = join(root, "delivery.ts");
  const control = join(import.meta.dir, "../scripts/live/control");
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    Object.defineProperty(process, "platform", {value:"darwin"});
    const root = ${JSON.stringify(root)};
    for (const dir of ["scripts/live/native","desktop/native"]) mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,"scripts/live/native/main.swift"),"fixed test observer");
    writeFileSync(join(root,"desktop/native/permission-chip.swift"),"fixed test permissions");
    mock.module(${JSON.stringify(join(control,"../core.ts"))},()=>({checkout:root,atomicWrite:(path,bytes)=>writeFileSync(path,bytes)}));
    mock.module(${JSON.stringify(join(control,"ota-binding.ts"))},()=>({resolveDesktopControlBinding:()=>{throw Error("unexpected authority read")},assertSameControlBinding:()=>{throw Error("unexpected authority comparison")}}));
    let receipt, calls = 0;
    const stream = value => new Response(JSON.stringify(value)).body;
    Bun.spawn = (argv) => {
      if (argv[0] === "/usr/bin/swiftc") writeFileSync(argv.at(-1),"fixed test executable");
      if (argv[0].endsWith("pacer-native-control")) {
        calls++;
        return {stdout:stream(receipt),stderr:stream(""),exited:Promise.resolve(0),kill:()=>{}};
      }
      if (!["/usr/bin/swiftc","/usr/bin/codesign"].includes(argv[0])) throw Error("unexpected fixture spawn");
      return {stdout:stream(""),stderr:stream(""),exited:Promise.resolve(0),kill:()=>{}};
    };
    const {nativeCommand} = await import(${JSON.stringify(join(control,"desktop.ts"))});
    const results = [];
    for (const delivery of ["unknown","not_delivered",undefined,"invalid","delivered"]) {
      receipt = {ok:false,error:{code:"target_unavailable",message:"native failed"},delivery};
      try { await nativeCommand({command:"act"}); results.push("unexpected success"); }
      catch (error) { results.push({code:error.code,delivery:error.delivery}); }
    }
    console.log(JSON.stringify({results,calls}));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ calls: 5, results: [
    { code: "target_unavailable", delivery: "unknown" },
    { code: "target_unavailable", delivery: "not_delivered" },
    { code: "target_unavailable", delivery: "unknown" },
    { code: "target_unavailable", delivery: "unknown" },
    { code: "target_unavailable", delivery: "unknown" },
  ] });
});
