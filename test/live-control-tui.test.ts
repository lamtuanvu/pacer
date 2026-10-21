import { expect, test } from "bun:test";
import { createTuiAdapter } from "../scripts/live/control/tui";
import { dispatch } from "../scripts/live/control/dispatch";
import type { Session } from "../scripts/live/core";
test("TUI adapter advertises text capture and refuses clicks", async () => {
  const adapter = createTuiAdapter({ id: "contract" } as Session);
  const result = await dispatch({ command: "act", surface: "tui", action: { kind: "click", x: 1, y: 1, capture_id: "image" } }, adapter);
  expect(result.error?.code).toBe("unsupported_capability");
});


test("an expired TUI mutation terminates its owned client and reports uncertain delivery", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { operationContext } = await import("../scripts/live/control/deadline");
  const root=mkdtempSync(join(tmpdir(),"live-tui-timeout-"));
  for(const directory of ["bin","repo","home"]) mkdirSync(join(root,directory));
  writeFileSync(join(root,"bin/tmux"),"#!/bin/sh\nexec /bin/sleep 3\n",{mode:0o700});
  const clock=operationContext(40), started=Date.now();
  try {
    const adapter=createTuiAdapter({id:"deadline",root} as Session);
    const target=(await adapter.targets())[0];
    await expect(adapter.act(target,{kind:"key",key:"Tab"},clock.context)).rejects.toMatchObject({code:"command_timeout",delivery:"unknown"});
    expect(Date.now()-started).toBeLessThan(1500);
  } finally { clock.close(); rmSync(root,{recursive:true,force:true}); }
},10000);
