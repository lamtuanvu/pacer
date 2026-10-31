import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
const built = Bun.build({ entrypoints: ["test/fixtures/workspace-answer-browser.tsx"], target: "browser", splitting: false });
async function mount(page: Page, path: string, options: Record<string, unknown>) {
  const result = await built;
  expect(result.success).toBe(true);
  const source = await result.outputs.find(output => output.path.endsWith(".js"))!.text();
  await page.route("https://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Workspace</title><div id="app"></div>' }));
  await page.goto(`https://pacer.test/${path}`);
  await page.evaluate(options => { (window as any).OPTIONS = options; }, options);
  await page.evaluate(async code => { await import(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); }, source);
}
for (const scenario of [
  { name: "running delivered", state: "running", work: false, delivery: "turn_started" },
  { name: "running work held", state: "running", work: true, delivery: "held" },
  { name: "queued work delivered", state: "queued", work: true, delivery: "queued" },
  { name: "work needs input delivered", state: "needs_input", work: true, delivery: "pull" },
  { name: "settled work delivered", state: "done", work: true, delivery: "queued" },
]) browserTest(`Workspace question: ${scenario.name}`, async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();page.setDefaultTimeout(3000);
    await mount(page, "#/workspace?task=t-0412&tab=answer&repo=demo&scope=task", scenario);
    await page.locator(".pc-workspace").waitFor();
    const question = page.getByRole("region", { name: "Task question", exact: true });
    const box = question.getByRole("textbox", { name: "Your answer" });
    await box.waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    expect(page.url()).toContain("repo=demo&scope=task");
    if (scenario.state === "running" || scenario.state === "queued") expect(await page.getByRole("button", { name: /Accept result|Reject/ }).count()).toBe(0);
    await box.fill("  Use Stripe  ");
    await question.getByRole("button", { name: "Send answer" }).click();
    const held = scenario.delivery === "held";
    const status = page.getByRole("status").filter({ hasText: held ? "Answer held, not delivered yet" : "Answer sent." });
    await status.waitFor();
    await page.waitForFunction(() => (window as any).CALLS.filter((call: any) => call.op === "task.get").length >= 2 && (window as any).REFETCHES >= 1);
    const calls = await page.evaluate(() => (window as any).CALLS);
    const sent = calls.find((call: any) => call.op === "msg.send");
    expect(sent.params).toMatchObject({ to: "task:t-0412", kind: "answer", reply_to: "m-workspace", body: "Use Stripe" });
    expect(sent.params.request_id).toBeTruthy();
    expect(calls.some((call: any) => ["task.answer", "dispatch.answer"].includes(call.op))).toBe(false);
    const reads = calls.filter((call: any) => call.op === "msg.read");
    expect(reads.length).toBe(held ? 0 : 1);
    if (held) { await box.waitFor(); expect(await box.inputValue()).toBe(""); }
    else { expect(reads[0].params).toEqual({ ids: ["m-workspace"] }); await box.waitFor({ state: "detached" }); }
    expect(await status.count()).toBe(1);
    if (scenario.state === "queued") expect(calls.some((call: any) => call.op === "task.session")).toBe(false);
  } finally { await browser.close(); }
}, 15000);

browserTest("actual answer routes focus on reload and when entering Workspace", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();page.setDefaultTimeout(3000);
    await mount(page, "#/sessions/t-0412/answer?repo=demo&scope=task", { work: true });
    await page.getByRole("heading", { name: "Dispatch trace", exact: true }).waitFor();
    const box = page.getByRole("textbox", { name: "Your answer" });
    await box.waitFor();await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    expect(page.url()).toContain("#/tasks/t-0412?tab=answer&repo=demo&scope=task");
    await page.evaluate(() => { location.hash = "#/workspace?task=t-0412&tab=answer&repo=demo&scope=task"; });
    await page.locator(".pc-workspace").waitFor();await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    const hash = new URL(page.url()).hash;
    await mount(page, hash, { work: true });
    await page.locator(".pc-workspace").waitFor();await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    expect(await page.evaluate(() => (window as any).CALLS.some((call: any) => call.op === "msg.send" || call.op === "msg.read"))).toBe(false);
  } finally { await browser.close(); }
}, 15000);

browserTest("Workspace answer failure retains text, focus and retry request id; rapid clicks send once", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();page.setDefaultTimeout(3000);
    await mount(page, "#/workspace?task=t-0412&tab=answer", { work: true, failOnce: true });
    const box = page.getByRole("textbox", { name: "Your answer" });await box.fill("Use Stripe");
    const button = page.getByRole("button", { name: "Send answer" });
    await button.evaluate(element => { (element as HTMLButtonElement).click();(element as HTMLButtonElement).click(); });
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA" && !!document.querySelector('[aria-invalid="true"]'));
    expect(await box.inputValue()).toBe("Use Stripe");
    expect(await page.evaluate(() => (window as any).CALLS.filter((call: any) => call.op === "msg.send").length)).toBe(1);
    expect(await page.evaluate(() => (window as any).CALLS.some((call: any) => call.op === "msg.read"))).toBe(false);
    await button.click();await page.getByRole("status").filter({ hasText: "Answer sent." }).waitFor();
    const calls = await page.evaluate(() => (window as any).CALLS);
    const sends = calls.filter((call: any) => call.op === "msg.send");
    expect(sends.length).toBe(2);expect(sends[1].params.request_id).toBe(sends[0].params.request_id);
    expect(calls.filter((call: any) => call.op === "msg.read")).toHaveLength(1);
  } finally { await browser.close(); }
}, 15000);

browserTest("Workspace closed questions and ordinary navigation do not steal focus or offer an answer", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const options of [{ state: "stopped" }, { state: "done", review: true }, { state: "done", dismissed: true }, { state: "running" }]) {
      const page = await browser.newPage();page.setDefaultTimeout(3000);
      await mount(page, "#/workspace?task=t-0412", options);
      await page.locator(".pc-workspace").waitFor();
      await page.waitForFunction(() => (window as any).CALLS.some((call: any) => call.op === "task.get"));
      await page.getByRole("region", { name: options.state === "running" ? "Task question" : "Task result", exact: true }).waitFor();
      if (options.state === "running") {
        const box = page.getByRole("textbox", { name: "Your answer" });await box.waitFor();
        expect(await box.evaluate(element => document.activeElement === element)).toBe(false);
      } else expect(await page.getByRole("textbox", { name: "Your answer" }).count()).toBe(0);
      await page.close();
    }
  } finally { await browser.close(); }
}, 15000);

for (const delivery of ["turn_started", "held"]) browserTest(`retained child receives same-rev/state question with root selected: ${delivery}`, async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();page.setDefaultTimeout(3000);
    await mount(page, "#/workspace?task=t-0412&tab=answer", { retained: true, delivery });
    await page.getByRole("region", { name: "Task question", exact: true }).waitFor({ state: "detached" });
    await page.waitForFunction(() => (window as any).RESOLVED.includes("t-0412"));
    await page.getByRole("button", { name: "Select task: Selected root", exact: true }).click();
    await page.locator(".pc-workspace-task__title").filter({ hasText: "Selected root" }).waitFor();
    const before = await page.evaluate(() => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length);
    const rootReads = await page.evaluate(() => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "root-task").length);
    await page.evaluate(() => (window as any).PUBLISH_QUESTION());
    const box = page.getByRole("textbox", { name: "Your answer" });
    await box.waitFor();await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    expect(await page.evaluate(() => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length)).toBeGreaterThan(before);
    expect(await page.getByText("Wrong root question", { exact: true }).count()).toBe(0);
    // Another client reads the question before this panel sends anything. The task
    // stays at the original rev/state and its snapshot messages become empty again.
    await page.evaluate(() => (window as any).REMOVE_QUESTION());
    await box.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as any).CALLS.some((c: any) => c.op === "msg.send" || c.op === "msg.read"))).toBe(false);
    const afterRemoval = await page.evaluate(() => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length);
    expect(afterRemoval).toBeGreaterThan(before + 1);
    await page.evaluate(() => (window as any).PUBLISH_QUESTION());
    await box.waitFor();await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    const beforeSend = await page.evaluate(() => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length);
    await box.fill("Use Stripe");await page.getByRole("button", { name: "Send answer" }).click();
    await page.getByRole("status").filter({ hasText: delivery === "held" ? "Answer held, not delivered yet" : "Answer sent." }).waitFor();
    await page.waitForFunction(n => (window as any).CALLS.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length > n, beforeSend);
    if (delivery === "held") { await box.waitFor();expect(await box.inputValue()).toBe(""); }
    else await box.waitFor({ state: "detached" });
    // The read model can still contain the unread question after the fresh post-send detail arrives.
    await page.evaluate(() => (window as any).TICK());
    if (delivery !== "held") expect(await box.count()).toBe(0);
    const calls = await page.evaluate(() => (window as any).CALLS);
    expect(calls.filter((c: any) => c.op === "task.get" && c.params.id === "root-task")).toHaveLength(rootReads);
    expect(calls.filter((c: any) => c.op === "msg.send")).toHaveLength(1);
    expect(calls.find((c: any) => c.op === "msg.send").params).toMatchObject({ to: "task:t-0412", reply_to: "m-workspace" });
    expect(calls.filter((c: any) => c.op === "msg.read").map((c: any) => c.params)).toEqual(delivery === "held" ? [] : [{ ids: ["m-workspace"] }]);
    expect(calls.some((c: any) => ["task.answer", "dispatch.answer"].includes(c.op))).toBe(false);
    expect(calls.filter((c: any) => c.op === "task.get" && c.params.id === "t-0412").length).toBeLessThanOrEqual(before + 5);
    expect(await page.locator(".pc-workspace-task__title").textContent()).toContain("Selected root");
  } finally { await browser.close(); }
}, 15000);
