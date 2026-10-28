import type { UI_ICONS } from "../../../src/plugins/ui-schema";
import type { IconName } from "../ds/icons";
/** Closed host mapping; plugin names never become SVG or CSS. */
export const PLUGIN_ICONS = {
  "check-square": "checks", list: "tasks", bell: "bell", chart: "insights", clock: "time", cog: "settings", file: "files", folder: "layers", "git-branch": "branch", key: "accounts", link: "external", shield: "review", tag: "notes", terminal: "terminal", users: "accounts", zap: "dispatch", plugin: "plugin",
} satisfies Record<(typeof UI_ICONS)[number], IconName>;
