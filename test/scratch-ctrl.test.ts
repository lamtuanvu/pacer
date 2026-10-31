import { test, expect } from "bun:test";
import { createKeyRegistry } from "../app/src/keys/registry";
import { createCommandRegistry } from "../app/src/keys/commands";
import { registerShellCommands } from "../app/src/shell/shell-commands";
test("ctrl-1 in textarea on non-apple", () => {
  const keys = createKeyRegistry({ controlActive: () => false, mac: false });
  const commands = createCommandRegistry(keys);
  const calls: string[] = [];
  registerShellCommands(commands, keys, { go: h=>calls.push(h), back(){}, forward(){}, openNewTask(){}, showHelp(){}, apple:false, desktop:true });
  const target = { tagName: "TEXTAREA" };
  const event: any = { key: "1", ctrlKey: true, metaKey: false, altKey: false, target, preventDefault(){ event.prevented = true; } };
  const handled = keys.handle(event);
  console.log("handled", handled, "prevented", event.prevented, "calls", calls);
});
