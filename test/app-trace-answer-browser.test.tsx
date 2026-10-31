import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
async function build() {
  const result = await Bun.build({ entrypoints: ["test/fixtures/trace-answer-browser.tsx"], target: "browser", splitting: false });
  expect(result.success).toBe(true);
  return result.outputs.find(output => output.path.endsWith(".js"))!.text();
}

for (const scenario of [
  { name: "running delivered", state: "running", work: false, delivery: "turn_started", focus: true },
  { name: "running work held", state: "running", work: true, delivery: "held", focus: true },
  { name: "work needs input delivered", state: "needs_input", work: true, delivery: "pull", focus: true },
  { name: "settled work delivered", state: "done", work: true, delivery: "queued", focus: false },
]) browserTest(`Screen task question: ${scenario.name}`, async () => {
  const source = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Task</title><div id="app"></div>' }));
    await page.goto(`https://pacer.test/#/${scenario.focus ? "sessions/t-0412/answer" : "tasks/t-0412"}?repo=demo&scope=task`);
    await page.evaluate(options => { (window as any).OPTIONS = options; }, scenario);
    await page.evaluate(async code => { await import(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); }, source);
    await page.getByRole("heading", { name: "Dispatch trace", exact: true }).waitFor();
    const question = page.getByRole("region", { name: "Task question" });
    await question.getByText("Which provider should the flow use?").waitFor({ timeout: 2000 });
    const box = question.getByRole("textbox", { name: "Your answer" });
    if (scenario.focus) {
      expect(page.url()).toContain("#/tasks/t-0412?");
      expect(new URLSearchParams(page.url().split("?")[1]).get("tab")).toBe("answer");
      expect(new URLSearchParams(page.url().split("?")[1]).get("repo")).toBe("demo");
      expect(new URLSearchParams(page.url().split("?")[1]).get("scope")).toBe("task");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Your answer" || document.activeElement?.tagName === "TEXTAREA", null, { timeout: 2000 });
    } else expect(await box.evaluate(element => document.activeElement === element)).toBe(false);
    if (scenario.state === "running") {
      expect(await page.getByRole("button", { name: /Accept result|Reject/ }).count()).toBe(0);
    }
    await box.fill("Use Stripe");
    await question.getByRole("button", { name: "Send answer" }).click();
    const held = scenario.delivery === "held";
    const status = page.getByRole("status").filter({ hasText: held ? "Answer held, not delivered yet" : scenario.delivery === "queued" ? "Answer sent. The task will continue next." : scenario.delivery === "pull" ? "Answer sent. The task will read it." : "Answer sent. The task is continuing." });
    await status.waitFor();
    await page.waitForFunction(() => (window as any).CALLS.filter((call: any) => call.op === "task.get").length >= 2 && (window as any).REFETCHES >= 1);
    const calls = await page.evaluate(() => (window as any).CALLS);
    const sent = calls.find((call: any) => call.op === "msg.send");
    expect(sent.params).toMatchObject({ to: "task:t-0412", kind: "answer", reply_to: "m-1", body: "Use Stripe" });
    expect(sent.params.request_id).toBeTruthy();
    const reads = calls.filter((call: any) => call.op === "msg.read");
    expect(reads.length).toBe(held ? 0 : 1);
    if (held) { await box.waitFor(); expect(await question.getByText("Which provider should the flow use?").count()).toBe(1); }
    else { expect(reads[0].params).toEqual({ ids: ["m-1"] }); await box.waitFor({ state: "detached" }); }
    expect(await status.count()).toBe(1);
  } finally { await browser.close(); }
}, 30000);
