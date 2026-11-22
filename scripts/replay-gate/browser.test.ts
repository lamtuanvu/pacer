import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserComparator } from "./browser";

test("Chromium pixel comparison accepts identical replay and detects text, cursor, color, width, strikethrough and cursor-visibility changes", async () => {
  const output = await mkdtemp(join(tmpdir(),"pacer-vt100-pixels-"));
  let browser:Awaited<ReturnType<typeof browserComparator>>|undefined;
  try {
    browser = await browserComparator(output);
    const reference = "hello 世界\x1b[31m!\x1b[0m";
    expect((await browser.compare("same",reference,reference)).equal).toBe(true);
    for (const [id,suffix] of [
      ["text","X"],                                    // extra glyph changes pixels
      ["cursor","\x1b[H"],                             // moved cursor changes pixels
      ["color","\x1b[1;1H\x1b[32mh"],                  // SGR color change
      ["wide","\x1b[1;7HZ"],                            // wide glyph changes columns
      ["strikethrough","\x1b[9mo"],                     // SGR 9: line-through must render
      ["cursor-visible","\x1b[?25l"],                   // hidden cursor must differ from visible
    ]) {
      expect((await browser.compare(id!,reference,reference+suffix)).equal).toBe(false);
    }
  } finally {await browser?.close();await rm(output,{recursive:true,force:true});}
},30000);
