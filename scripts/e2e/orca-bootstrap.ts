/** Real Orca release check. Never registers com.pacer.serve with the user's manager. */
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBootstrap, resolveOrcaCli, runFile } from "../../orca-plugin/src/bootstrap";
import { shellCommand } from "../../src/install/fsx";
import { servicePath } from "../../src/service";
import type { OrcaWorkerContext } from "../../orca-plugin/src/orca-api";
import pkg from "../../package.json";
let binary = resolve("dist/pacer"), path = process.env.PATH || "", keep = false, setup = false, worktree: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
 const arg = process.argv[i];
 if (arg === "--binary" && process.argv[i+1]) binary = resolve(process.argv[++i]);
 else if (arg === "--path" && process.argv[i+1] !== undefined) path = process.argv[++i];
 else if (arg === "--worktree" && process.argv[i+1]) worktree = process.argv[++i];
 else if (arg === "--keep") keep = true;
 else if (arg === "--set-up") setup = true;
 else throw new Error("usage: bun scripts/e2e/orca-bootstrap.ts [--binary path] [--path PATH] [--worktree id] [--set-up] [--keep]");
}
const realHome = process.env.HOME!;
const cli = resolveOrcaCli(process.env);
const home = mkdtempSync(join(tmpdir(), "pacer-orca-e2e-")), safety = join(home,"safety-bin"), pacerHome = join(home,".pacer");
mkdirSync(safety);mkdirSync(pacerHome);
const env: NodeJS.ProcessEnv = { HOME:home, PACER_HOME:pacerHome, PATH:path, PACER_BIN:binary, ORCA_CLI_COMMAND:cli, USER:process.env.USER, SHELL:"/bin/sh" };
const orcaEnv = {...env, HOME:realHome};
const handles: string[] = [], store = new Map<string,unknown>();
// init's internal service backend must be isolated too: pre-mark only the temp service as installed,
// and shadow manager executables so neither queries nor mutations reach the real user manager.
const service = servicePath({home} as any, process.platform);
mkdirSync(join(service,".."),{recursive:true});writeFileSync(service,"E2E service stub; not a real service definition\n");
for(const manager of ["launchctl","systemctl"]){const target=join(safety,manager);writeFileSync(target,"#!/bin/sh\necho 'E2E: service manager stub' >&2\nexit 1\n");chmodSync(target,0o755);}
const wrapper=join(safety,"pacer");
writeFileSync(wrapper,`#!/bin/sh\nif [ "$1" = service ]; then\n  echo 'E2E: pacer service stub' >&2\n  case "$2" in status) echo '{"installed":${setup}}';; install|uninstall) :;; *) exit 2;; esac\n  exit 0\nfi\nexec ${shellCommand([binary])} "$@"\n`);chmodSync(wrapper,0o755);
if(setup) writeFileSync(join(pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
let context:any=null;
const ctx = {log:console.log,host:{call:async(method:string,params:any)=>{
 if(method==="workspace.readContext")return context;
 if(method==="settings.get")return {settings:{}};
 if(method==="storage.get")return {value:store.get(params.key)};
 if(method==="storage.set"){store.set(params.key,structuredClone(params.value));return {ok:true};}
 if(method==="notifications.show"){console.log("NOTIFY",params.title);return {delivered:true};}
 throw new Error(`unsupported host call ${method}`);
}}} as unknown as OrcaWorkerContext;
const exec = async (bin:string,args:string[],e:NodeJS.ProcessEnv,timeout:number) => {
 console.log("EXEC",shellCommand([bin,...args]));
 if(bin===binary && args[0]==="service"){
  if(!["status","install","uninstall"].includes(args[1]))throw new Error("refused service operation");
  console.log("  STUBBED service operation");return args[1]==="status"?JSON.stringify({installed:setup}):"";
 }
 if(bin===cli && args[0]==="terminal" && args[1]==="create"){
  const safeArgs=[...args],index=safeArgs.indexOf("--command");
  // The terminal inherits Orca's HOME unless overridden in its command. Protect both
  // the agent configs and the service manager, including an interactive init rerun.
  safeArgs[index+1]=shellCommand(["/usr/bin/env",`HOME=${home}`,`PACER_HOME=${pacerHome}`,`PATH=${safety}:${path}`,`PACER_BIN=${wrapper}`,wrapper,setup?"dashboard":"init"]);
  console.log("  ISOLATED",safeArgs[index+1]);
  const output=await runFile(cli,safeArgs,orcaEnv,timeout),reply=JSON.parse(output);
  if(reply.result?.terminal?.handle)handles.push(reply.result.terminal.handle);
  return output;
 }
 return runFile(bin,args,bin===cli?orcaEnv:e,timeout);
};
try {
 console.log("Temporary HOME",home,"CLI",cli,"PATH",path);
 const rows=JSON.parse(await exec(cli,["worktree","list","--json"],env,30_000)).result?.worktrees ?? [];
 const row=worktree?rows.find((r:any)=>r.id===worktree):rows.find((r:any)=>resolve(r.path)===process.cwd());
 if(!row)throw new Error("No worktree matches CWD; pass --worktree with an ID from orca worktree list --json");
 // The standalone harness has no worker host. Emulate readContext for this explicitly selected
 // real worktree, omitting worktreeId to exercise the Orca 1.4.224 compatibility resolver.
 context={branch:row.branch,displayName:row.displayName,terminals:[]};
 const bootstrap=createBootstrap({mode:"bootstrap",home,env,version:pkg.version,exec});
 await bootstrap.activate(ctx);await bootstrap.run(ctx,()=>{});
 console.log("FINAL STATE",JSON.stringify(bootstrap.state,null,2));
 if(bootstrap.state.install.status!=="done" || bootstrap.state.start.status!=="done" || !handles.length)throw new Error("Bootstrap did not open its terminal");
 await new Promise(resolve=>setTimeout(resolve,1500));
 for(const handle of handles)console.log("TERMINAL",await exec(cli,["terminal","read","--terminal",handle,"--json"],env,30_000));
} finally {
 if(!keep){for(const handle of handles)await exec(cli,["terminal","close","--terminal",handle,"--json"],env,30_000);rmSync(home,{recursive:true,force:true});}
 else console.log("Kept terminals",handles,"and temp HOME",home);
}
