import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Combobox, comboboxEnter, comboboxItems, comboboxStep } from "../app/src/ds/Combobox";

const options = [
  { value: "opus", description: "Hardest work", group: "Aliases" },
  { value: "sonnet", description: "Everyday coding", group: "Aliases" },
  { value: "claude-opus-5-5", description: "Opus 5.5", group: "Pinned" },
];

test("typing filters on value and description; the typed text is offered last unless already listed", () => {
  expect(comboboxItems(options, "", true).map(item => item.option.value)).toEqual(["opus", "sonnet", "claude-opus-5-5"]);
  expect(comboboxItems(options, "OPUS", true).map(item => [item.option.value, item.custom])).toEqual([["opus", false], ["claude-opus-5-5", false], ["OPUS", true]]);
  expect(comboboxItems(options, "everyday", true).map(item => item.option.value)).toEqual(["sonnet", "everyday"]);
  expect(comboboxItems(options, " opus ", true).map(item => item.custom)).toEqual([false, false]);
  expect(comboboxItems(options, "my-model", false)).toEqual([]);
});

test("arrow keys move the active option and wrap; other keys leave it alone", () => {
  expect(comboboxStep("ArrowDown", -1, 3)).toBe(0);
  expect(comboboxStep("ArrowDown", 2, 3)).toBe(0);
  expect(comboboxStep("ArrowUp", -1, 3)).toBe(2);
  expect(comboboxStep("ArrowUp", 0, 3)).toBe(2);
  expect(comboboxStep("ArrowDown", 0, 0)).toBeUndefined();
  expect(comboboxStep("Enter", 1, 3)).toBeUndefined();
});

test("the combobox is a labelled editable field that controls a grouped listbox (WAI-ARIA combobox)", () => {
  const html = renderToString(<Combobox label="Add a model" options={options} onPick={() => {}} placeholder="Search or type any id" source="From Claude Code" mono />);
  // Attribute order differs between renderers; match each attribute on the label separately.
  const label = /<label[^>]*>Add a model<\/label>/.exec(html)![0];
  expect(label).toContain('class="pc-combobox__label"');
  const id = /for="(combobox-[^"]+)"/.exec(label)![1]!;
  const input = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)![0];
  expect(input).toContain('role="combobox"');
  expect(html).toContain(`aria-controls="${id}-list"`);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-autocomplete="list"');
  const list = new RegExp(`<div[^>]*id="${id}-list"[^>]*>`).exec(html)![0];
  for (const attribute of ['role="listbox"', 'aria-label="Add a model"', 'hidden']) expect(list).toContain(attribute);
  // Groups name their options; every option is a listbox option, never a nested button.
  expect(html.match(/role="group"/g)).toHaveLength(2);
  expect(html.match(/role="option"/g)).toHaveLength(3);
  expect(html).not.toContain("<button");
  expect(html).toContain("pc-combobox__value--mono");
  expect(html).toContain("From Claude Code");
  expect(html).toContain('role="status" aria-live="polite"');
});

test("an empty list says what to do instead of rendering nothing", () => {
  const html = renderToString(<Combobox label="Add models" options={[]} onPick={() => {}} emptyLabel="Type a model id to add it." disabled />);
  expect(html).toContain("Type a model id to add it.");
  expect(html).toMatch(/<input[^>]*disabled/);
});

test("B2: with nothing highlighted, Enter adds exactly what was typed, never a longer substring match", () => {
  const listed = [{ value: "glm-4.6" }, { value: "glm" }, { value: "gpt-5-codex" }];
  const enter = (query: string, active = -1) => { const items = comboboxItems(listed, query, true); const at = comboboxEnter(items, active, query); return at < 0 ? null : [items[at]!.option.value, items[at]!.custom]; };
  // An exact listed id picks that option (and so its suggested size).
  expect(enter("glm")).toEqual(["glm", false]);
  // An unlisted id that is a prefix of a listed one adds the typed id, not the listed one.
  expect(enter("gpt-5")).toEqual(["gpt-5", true]);
  expect(enter("  gpt-5  ")).toEqual(["gpt-5", true]);
  // A highlighted option wins; nothing typed and nothing highlighted picks nothing.
  expect(enter("glm", 0)).toEqual(["glm-4.6", false]);
  expect(enter("")).toBeNull();
  expect(comboboxEnter(comboboxItems(listed, "zzz", false), -1, "zzz")).toBe(-1);
});

test("UI-2: an already-added option is listed but disabled, and typing it does not offer a custom add", () => {
  const listed = [{ value: "terastor-ai", disabled: true, disabledLabel: "Already added" }, { value: "terastor-ai-pro" }];
  const items = comboboxItems(listed, "terastor-ai", true);
  expect(items.map(item => [item.option.value, item.custom])).toEqual([["terastor-ai", false], ["terastor-ai-pro", false]]);
  expect(items[comboboxEnter(items, -1, "terastor-ai")]!.option.disabled).toBe(true);
  const html = renderToString(<Combobox label="Add a model" options={listed} onPick={() => {}} />);
  expect(html).toMatch(/role="option"[^>]*aria-disabled="true"/);
  expect(html).toContain("Already added");
});
