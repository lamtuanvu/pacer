import type { BrowserContext, Page, ElementHandle } from "playwright-core";
import { createHash } from "node:crypto";
import { ControlError, MAX_ELEMENTS, type Action, type CaptureResult, type Element, type Observation, type SurfaceAdapter, type Target } from "./contract";

export function createBrowserAdapter(context: BrowserContext, origin: string): SurfaceAdapter {
  const pages = new Map<string, Page>();
  const refs = new Map<string, { revision: string; handles: Map<string, ElementHandle> }>();
  const generations = new WeakMap<Page, string>();
  let nextPage = 0;
  const captures = new Map<string, { id: string; generation: string; width: number; height: number; scale: number }>();
  function pageFor(target: Target): Page {
    const page = pages.get(target.id);
    if (!page || page.isClosed()) throw new ControlError("target_unavailable", "browser page closed");
    if (new URL(page.url()).origin !== origin || new URL(page.url()).pathname.startsWith("/app/auth")) throw new ControlError("origin_changed", "page left authenticated sandbox; inspect and sign in again");
    if (generations.get(page) !== target.generation) throw new ControlError("stale_reference", "page navigated");
    return page;
  }
  async function targets(): Promise<Target[]> {
    for (const page of context.pages()) {
      if (![...pages.values()].includes(page)) {
        pages.set(nextPage++ === 0 ? "main" : `page-${nextPage}`, page);
        generations.set(page, crypto.randomUUID());
        page.on("framenavigated", frame => { if (frame === page.mainFrame()) { generations.set(page, crypto.randomUUID()); refs.clear(); } });
      }
    }
    return [...pages].filter(([, page]) => !page.isClosed()).map(([id, page]) => ({
      id, surface: new URL(page.url()).pathname.endsWith("/tray.html") ? "tray" : "web",
      generation: generations.get(page)!, capabilities: ["inspect", "click", "type", "key", "scroll", "select", "resize", "activate", "capture"],
    }));
  }
  async function inspect(target: Target): Promise<Observation> {
    const page = pageFor(target);
    const handles = await page.locator('button,a[href],input,textarea,select,nav,[role],[tabindex],h1,h2,h3').elementHandles();
    const elements: Element[] = [];
    const map = new Map<string, ElementHandle>();
    for (const handle of handles.slice(0, MAX_ELEMENTS)) {
      if (!await handle.isVisible()) { await handle.dispose(); continue; }
      const data = await handle.evaluate(element => {
        const node = element as HTMLElement;
        const world = window as unknown as { __pacerLiveIDs?: { next: number; refs: WeakMap<globalThis.Element, string> } };
        const ids = world.__pacerLiveIDs ??= { next: 0, refs: new WeakMap() };
        let stableRef = ids.refs.get(node);
        if (!stableRef) { stableRef = `e${++ids.next}`; ids.refs.set(node, stableRef); }
        const input = node as HTMLInputElement;
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role") ?? ({ nav: "navigation", button: "button", a: "link", textarea: "textbox", select: "combobox", h1: "heading", h2: "heading", h3: "heading" }[tag] ?? (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" }[input.type] ?? "textbox") : "generic"));
        const labelled = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        const labels = "labels" in input && input.labels ? Array.from(input.labels).map(label => label.textContent?.trim()).join(" ") : "";
        const name = node.getAttribute("aria-label") ?? (labelled || labels || node.innerText?.trim() || node.getAttribute("title") || input.placeholder || "");
        const bounds = node.getBoundingClientRect();
        const sensitive = input.type === "password" || input.autocomplete === "one-time-code";
        const value = sensitive ? undefined : ("value" in input ? input.value : undefined);
        const ancestors: Array<{role: string; name: string}> = [];
        for (let parent = node.parentElement; parent && ancestors.length < 50; parent = parent.parentElement) {
          const ancestorRole = parent.getAttribute("role") ?? ({ nav: "navigation", main: "main", form: "form", section: "region" }[parent.tagName.toLowerCase()] ?? "generic");
          const ancestorName = parent.getAttribute("aria-label") ?? (parent.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
          if (ancestorRole !== "generic") ancestors.push({ role: ancestorRole, name: ancestorName });
        }
        return { stableRef, role, name, value, sensitive, ancestors, disabled: input.disabled === true, focused: document.activeElement === node,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          actions: tag === "input" || tag === "textarea" ? ["type", "key", "click"] : tag === "select" ? ["select", "key"] : ["click", "key"],
        };
      });
      const { stableRef: ref, ...attributes } = data; elements.push({ ref, ...attributes }); map.set(ref, handle);
    }
    // Revision includes document generation and visible control state; all refs revalidated before action.
    const revision = createHash("sha256").update(JSON.stringify([target.generation, elements])).digest("hex").slice(0, 24);
    const old = refs.get(target.id); if (old) for (const handle of old.handles.values()) await handle.dispose();
    refs.set(target.id, { revision, handles: map });
    return { target, revision, elements, truncated: handles.length > MAX_ELEMENTS };
  }
  return {
    targets, inspect,
    act: async (target: Target, action: Action) => {
      const page = pageFor(target);
      const snapshot = refs.get(target.id);
      if (action.ref && (!snapshot || action.revision !== snapshot.revision || action.generation !== target.generation)) throw new ControlError("stale_reference", "inspect again", "not_delivered");
      const handle = action.ref ? snapshot?.handles.get(action.ref) : undefined;
      if (action.ref && !handle) throw new ControlError("stale_reference", "control disappeared", "not_delivered");
      const options = { timeout: 5000 };
      switch (action.kind) {
        case "click":
          if (action.x !== undefined && action.y !== undefined) {
            const capture = captures.get(target.id); const size = page.viewportSize();
            if (!capture || capture.id !== action.capture_id || capture.generation !== target.generation || capture.width !== size?.width || capture.height !== size?.height) throw new ControlError("stale_reference", "coordinate image is stale", "not_delivered");
            if (action.x < 0 || action.y < 0 || action.x >= capture.width * capture.scale || action.y >= capture.height * capture.scale) throw new ControlError("invalid_input", "coordinates outside capture", "not_delivered");
            await page.mouse.click(action.x / capture.scale, action.y / capture.scale); break;
          }
          if (!handle) throw new ControlError("invalid_input", "click requires selector or ref", "not_delivered"); await handle.click(options); break;
        case "type": if (handle) { if (await handle.getAttribute("type") === "password") throw new ControlError("sensitive_input", "credential entry is outside live control", "not_delivered"); await handle.fill(action.text!, options); } else await page.keyboard.insertText(action.text!); break;
        case "key": if (handle) await handle.press(action.key!, options); else await page.keyboard.press(action.key!); break;
        case "select": if (!handle) throw new ControlError("invalid_input", "select requires target", "not_delivered"); await handle.selectOption(action.value!, options); break;
        case "scroll": await page.mouse.wheel(action.delta_x ?? 0, action.delta_y ?? 400); break;
        case "resize": await page.setViewportSize({ width: action.width!, height: action.height! }); break;
        case "activate": await page.bringToFront(); break;
      }
      return { delivery: "delivered" };
    },
    capture: async (target, _mode, captureId): Promise<CaptureResult> => {
      const page = pageFor(target); const size = page.viewportSize();
      // Mask password/OTP controls in stored images; image metadata is still browser evidence.
      const bytes = await page.screenshot({ type: "png", timeout: 5000, mask: [page.locator('input[type="password"],input[autocomplete="one-time-code"]')] });
      const scale = await page.evaluate(() => devicePixelRatio);
      if (captureId && size) captures.set(target.id, { id: captureId, generation: target.generation, ...size, scale });
      return { method: "browser", bytes, mime: "image/png", width: size?.width, height: size?.height, scale };
    },
    close: async () => { await context.close(); },
  };
}
