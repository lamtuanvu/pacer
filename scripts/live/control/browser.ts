import type { BrowserContext, Page } from "playwright-core";
import { createHash } from "node:crypto";
import { ControlError, MAX_ELEMENTS, type Action, type CaptureResult, type Observation, type SurfaceAdapter, type Target } from "./contract";
import type { OperationContext } from "./deadline";

export function createBrowserAdapter(context: BrowserContext, origin: string): SurfaceAdapter {
  const pages = new Map<string, Page>();
  const generations = new WeakMap<Page, string>();
  const revisions = new Map<string, string>();
  const captures = new Map<string, { id: string; generation: string; width: number; height: number; scale: number; at: number }>();
  let nextPage = 0;
  function pageFor(target: Target): Page {
    const page = pages.get(target.id);
    if (!page || page.isClosed()) throw new ControlError("target_unavailable", "browser page closed");
    if (new URL(page.url()).origin !== origin || new URL(page.url()).pathname.startsWith("/app/auth")) {
      throw new ControlError("origin_changed", "page left authenticated sandbox; inspect and sign in again");
    }
    if (generations.get(page) !== target.generation) throw new ControlError("stale_reference", "page navigated");
    return page;
  }
  async function targets(clock?: OperationContext): Promise<Target[]> {
    clock?.check();
    for (const page of context.pages()) {
      if ([...pages.values()].includes(page)) continue;
      pages.set(nextPage++ === 0 ? "main" : `page-${nextPage}`, page);
      generations.set(page, crypto.randomUUID());
      page.on("framenavigated", frame => {
        if (frame === page.mainFrame()) generations.set(page, crypto.randomUUID());
      });
    }
    return [...pages].filter(([, page]) => !page.isClosed()).map(([id, page]) => ({
      id, surface: new URL(page.url()).pathname.endsWith("/tray.html") ? "tray" : "web",
      generation: generations.get(page)!,
      capabilities: ["inspect", "click", "type", "key", "scroll", "select", "resize", "activate", "capture"],
    }));
  }
  async function inspect(target: Target, clock?: OperationContext): Promise<Observation> {
    clock?.check();
    const page = pageFor(target);
    // One DOM round trip rather than two RPCs for each of thousands of controls.
    const data = await page.evaluate(max => {
      type World = { __pacerLiveIDs?: { next: number; ids: WeakMap<Element, string>; refs: Map<string, Element> } };
      const world = window as unknown as World;
      const state = world.__pacerLiveIDs ??= { next: 0, ids: new WeakMap(), refs: new Map() };
      state.refs.clear();
      const controls = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,nav,[role],[tabindex],h1,h2,h3'));
      const elements = [];
      let truncated = false;
      const clip = (text: string) => { if (text.length > 4096) truncated = true; return text.slice(0, 4096); };
      for (const element of controls) {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        if (!node.getClientRects().length || style.visibility === "hidden" || node.closest('[aria-hidden="true"]')) continue;
        if (elements.length >= max) { truncated = true; break; }
        let ref = state.ids.get(node);
        if (!ref) { ref = `e${++state.next}`; state.ids.set(node, ref); }
        state.refs.set(ref, node);
        const input = node as HTMLInputElement;
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role") ?? ({ nav: "navigation", button: "button", a: "link", textarea: "textbox", select: "combobox", h1: "heading", h2: "heading", h3: "heading" }[tag] ?? (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" }[input.type] ?? "textbox") : "generic"));
        const labelled = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        const labels = input.labels ? Array.from(input.labels).map(label => label.textContent?.trim()).join(" ") : "";
        const name = clip(node.getAttribute("aria-label") ?? (labelled || labels || node.innerText?.trim() || node.getAttribute("title") || input.placeholder || ""));
        const bounds = node.getBoundingClientRect();
        const sensitive = input.type === "password" || input.autocomplete === "one-time-code";
        const value = sensitive ? undefined : ("value" in input ? clip(input.value) : undefined);
        const ancestors: Array<{role: string; name: string}> = [];
        for (let parent = node.parentElement; parent && ancestors.length < 50; parent = parent.parentElement) {
          const ancestorRole = parent.getAttribute("role") ?? ({ nav: "navigation", main: "main", form: "form", section: "region" }[parent.tagName.toLowerCase()] ?? "generic");
          const ancestorName = parent.getAttribute("aria-label") ?? (parent.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
          if (ancestorRole !== "generic") ancestors.push({ role: ancestorRole, name: clip(ancestorName) });
        }
        elements.push({ ref, role, name, value, sensitive, ancestors, disabled: input.disabled === true,
          focused: document.activeElement === node,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          actions: tag === "input" || tag === "textarea" ? ["type", "key", "click"] : tag === "select" ? ["select", "key"] : ["click", "key"],
        });
      }
      return { elements, truncated };
    }, MAX_ELEMENTS);
    clock?.check();
    const revision = createHash("sha256").update(JSON.stringify([target.generation, data.elements])).digest("hex").slice(0, 24);
    revisions.set(target.id, revision);
    return { target, revision, ...data };
  }
  return {
    targets, inspect,
    act: async (target: Target, action: Action, clock?: OperationContext) => {
      clock?.check();
      const page = pageFor(target);
      if (action.ref && (action.revision !== revisions.get(target.id) || action.generation !== target.generation)) {
        throw new ControlError("stale_reference", "inspect again", "not_delivered");
      }
      const object = action.ref ? await page.evaluateHandle(ref => {
        const world = window as unknown as { __pacerLiveIDs?: { refs: Map<string, Element> } };
        return world.__pacerLiveIDs?.refs.get(ref) ?? null;
      }, action.ref) : undefined;
      const handle = object?.asElement();
      try {
        if (action.ref && (!handle || !await handle.evaluate(node => node.isConnected))) throw new ControlError("stale_reference", "control disappeared", "not_delivered");
        if (action.kind === "type") {
          const secure = handle ? await handle.evaluate(node => (node as HTMLInputElement).type === "password" || (node as HTMLInputElement).autocomplete === "one-time-code") : await page.evaluate(() => {
            const node = document.activeElement as HTMLInputElement | null;
            return node?.type === "password" || node?.autocomplete === "one-time-code";
          });
          if (secure) throw new ControlError("sensitive_input", "credential entry is outside live control", "not_delivered");
        }
        clock?.check();
        pageFor(target);
        const options = { timeout: clock?.remaining() ?? 5000 };
        switch (action.kind) {
          case "click":
            if (action.x !== undefined && action.y !== undefined) {
              const capture = captures.get(target.id);
              const size = page.viewportSize();
              if (!capture || capture.id !== action.capture_id || capture.generation !== target.generation || capture.width !== size?.width || capture.height !== size?.height || Date.now() - capture.at > 10000) throw new ControlError("stale_reference", "coordinate image is stale", "not_delivered");
              if (action.x < 0 || action.y < 0 || action.x >= capture.width * capture.scale || action.y >= capture.height * capture.scale) throw new ControlError("invalid_input", "coordinates outside capture", "not_delivered");
              await page.mouse.click(action.x / capture.scale, action.y / capture.scale);
            } else {
              if (!handle) throw new ControlError("invalid_input", "click requires selector or ref", "not_delivered");
              await handle.click(options);
            }
            break;
          case "type": if (handle) await handle.fill(action.text!, options); else await page.keyboard.insertText(action.text!); break;
          case "key": if (handle) await handle.press(action.key!, options); else await page.keyboard.press(action.key!); break;
          case "select":
            if (!handle) throw new ControlError("invalid_input", "select requires a target", "not_delivered");
            await handle.selectOption(action.value!, options); break;
          case "scroll": await page.mouse.wheel(action.delta_x ?? 0, action.delta_y ?? 400); break;
          case "resize": await page.setViewportSize({ width: action.width!, height: action.height! }); break;
          case "activate": await page.bringToFront(); break;
        }
        return { delivery: "delivered" };
      } finally { await object?.dispose(); }
    },
    capture: async (target, _mode, captureId, clock): Promise<CaptureResult> => {
      clock?.check();
      const page = pageFor(target);
      const size = page.viewportSize();
      const bytes = await page.screenshot({ type: "png", timeout: clock?.remaining() ?? 5000,
        mask: [page.locator('input[type="password"],input[autocomplete="one-time-code"]')] });
      const scale = await page.evaluate(() => devicePixelRatio);
      clock?.check();
      if (captureId && size) captures.set(target.id, { id: captureId, generation: target.generation, ...size, scale, at: Date.now() });
      return { method: "browser", bytes, mime: "image/png", width: size?.width, height: size?.height, scale };
    },
    close: async () => { await context.close(); },
  };
}
