/** Elements that read as app chrome: not selectable, arrow cursor, no drag. Shared by native.css and the context-menu policy. */
export const CHROME_SELECTORS: readonly string[] = ["button", "[role=button]", "[role=tab]", "[role=menuitem]", "[role=option]", "summary", "label",
  ".pc-btn", ".pc-pill", ".pc-chip", ".pc-rail", ".pc-topbar", ".pc-statusbar", ".pc-panel-tabs",
  ".pc-settings-nav", ".pc-segmented"];
export const CHROME_SELECTOR: string = CHROME_SELECTORS.join(",");
