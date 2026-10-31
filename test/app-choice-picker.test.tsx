import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Field } from "../app/src/ds/Controls";
import { ChoicePicker } from "../app/src/ds/ChoicePicker";

const options = [
  { value: "codex", label: "Codex · work" },
  { value: "claude", label: "Claude Code · personal", disabled: true, reason: "Sign in first" },
];

test("choice picker presents the controlled selection without a native select popup", () => {
  const html = renderToString(
    <ChoicePicker value="codex" options={options} onValueChange={() => {}} name="executor" />,
  );
  expect(html).toContain("Codex · work");
  expect(html).toContain('aria-haspopup="listbox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('type="hidden"');
  expect(html).toContain('name="executor"');
  expect(html).toContain('value="codex"');
  expect(html).not.toContain("<select");
});

test("Field connects label, help and error to the choice trigger", () => {
  const html = renderToString(
    <Field label="Agent and account" help="Choose a ready executor" error="Choose an executor">
      <ChoicePicker id="agent-choice" value="" options={options} placeholder="Choose an executor…" required onValueChange={() => {}} />
    </Field>,
  );
  expect(html).toContain('for="agent-choice"');
  expect(html).toContain('id="agent-choice"');
  expect(html).toContain('aria-describedby="agent-choice-help agent-choice-error"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("Choose an executor…");
  expect(html).not.toContain("<select");
});

test("removed selection stays unselected instead of falling through to another option", () => {
  const html = renderToString(
    <ChoicePicker value="removed" options={options} placeholder="Choose an executor…" onValueChange={() => {}} />,
  );
  expect(html).toContain("Choose an executor…");
  expect(html).not.toContain('value="codex"');
  expect(html).not.toContain("Codex · work");
});

test("disabled named picker does not serialize a hidden value", () => {
  const html = renderToString(
    <ChoicePicker value="codex" options={options} name="executor" disabled onValueChange={() => {}} />,
  );
  expect(html).not.toContain('name="executor"');
});

for (const [agent, expected] of [["codex#team@devbox", "codex"], ["claude#personal", "claude-code"], ["opencode#byteplus", "byteplus"], ["agy", "agy"], ["cursor", "cursor"], ["opencode#custom", "opencode"], ["unknown-provider", "opencode"]]) {
  test(`choice picker decorates ${agent} without changing the label or form value`, () => {
    const html = renderToString(<ChoicePicker value="chosen" options={[{ value: "chosen", label: "Exact account label", agent }]} name="executor" onValueChange={() => {}} />);
    expect(html).toContain(`pc-agent-mark--${expected}`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('--agent-size:16px');
    expect(html).toContain('Exact account label');
    expect(html).toContain('value="chosen"');
    expect(html).not.toContain('role="img"');
  });
}

test("text choices and missing selections do not acquire a vendor mark", () => {
  for (const value of ["codex", "removed"]) {
    const html = renderToString(<ChoicePicker value={value} options={options} onValueChange={() => {}} />);
    expect(html).not.toContain('pc-agent-mark');
  }
});
