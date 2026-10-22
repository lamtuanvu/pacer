import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserComparator } from "./browser";

test("Chromium pixel comparison accepts identical replay and detects text, cursor, color and width changes", async () => {
  const output = await mkdtemp(join(tmpdir(),"pacer-vt100-pixels-"));
  let browser:Awaited<ReturnType<typeof browserComparator>>|undefined;
  try {
    browser = await browserComparator(output);
    const reference = "hello 世界\x1b[31m!\x1b[0m";
    expect((await browser.compare("same",reference,reference)).equal).toBe(true);
    for (const [id,suffix] of [["text","X"],["cursor","\x1b[H"],["color","\x1b[1;1H\x1b[32mh"],["wide","\x1b[1;7HZ"]]) {
      expect((await browser.compare(id!,reference,reference+suffix)).equal).toBe(false);
    }
  } finally {await browser?.close();await rm(output,{recursive:true,force:true});}
},30000);
