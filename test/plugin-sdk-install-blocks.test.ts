import {expect,test} from "bun:test";
import {blockText,hasBlock,removeBlock,upsertBlock,type BlockStyle} from "../packages/plugin-sdk/src/install/blocks";
const styles: BlockStyle[] = ["md", "hash"];
for (const style of styles) {
  const open = style === "md" ? "<!-- >>> pacer >>> -->" : "# >>> pacer >>>";
  const close = style === "md" ? "<!-- <<< pacer <<< -->" : "# <<< pacer <<<";

  test(`${style}: blockText normalizes trailing body newlines`, () => {
    expect(blockText("v1\n\n", style)).toBe(`${open}\nv1\n${close}\n`);
    expect(blockText("", style)).toBe(`${open}\n\n${close}\n`);
  });

  for (const original of ["", "# notes\n", "# notes\n\n", "line one\nline two\n"]) {
    test(`${style}: upsert and remove round-trip ${JSON.stringify(original)}`, () => {
      const v1 = upsertBlock(original, "v1", style);
      const v2 = upsertBlock(v1, "v2", style);
      const prefix = original === "" ? "" : `${original}\n`;
      expect(v1).toBe(`${prefix}${open}\nv1\n${close}\n`);
      expect(v2).toBe(`${prefix}${open}\nv2\n${close}\n`);
      expect(v2).toBe(upsertBlock(original, "v2", style));
      expect(removeBlock(v2, style)).toBe(original);
    });
  }

  test(`${style}: a block in the middle is replaced and removed in place`, () => {
    const original = `before\n${open}\nv1\n${close}\nafter\n`;
    expect(upsertBlock(original, "v2", style)).toBe(`before\n${open}\nv2\n${close}\nafter\n`);
    expect(removeBlock(original, style)).toBe("before\nafter\n");
  });

  test(`${style}: missing trailing newline gets added on round-trip`, () => {
    expect(removeBlock(upsertBlock("abc", "v1", style), style)).toBe("abc\n");
  });

  test(`${style}: detects complete blocks and leaves unmarked text alone`, () => {
    expect(hasBlock(`${open}\nv1\n${close}`, style)).toBe(true);
    expect(removeBlock(`${open}\nv1\n${close}`, style)).toBe("");
    expect(removeBlock("unrelated\n", style)).toBe("unrelated\n");
  });
}

for (const [style, open, close] of [
  ["md", "<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"],
  ["hash", "# >>> pacer >>>", "# <<< pacer <<<"],
] as const) {
  test(`${style}: orphan open markers reject detection, upsert, and removal`, () => {
    for (const text of [`before\n${open}\nuser text\n`, `${close}\nuser text\n${open}`]) {
      for (const operation of [
        () => hasBlock(text, style),
        () => upsertBlock(text, "new", style),
        () => removeBlock(text, style),
      ]) expect(operation).toThrow(`unmatched open marker: ${open}`);
    }
  });
}
