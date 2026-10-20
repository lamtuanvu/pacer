import type { ClientSnapshot } from "../../view-model/snapshot";
import type { Line } from "../frame";
import type { Item, UiState } from "../state";
import type { TerminalTheme } from "../theme";

/** A fetched resource: the last value stays visible while a refresh runs. */
export interface Resource<T> { value?: T; error?: { message: string; hint?: string; code?: string }; loading?: boolean }

/** `task.get` fields the TUI reads; every field is optional so older services still render. */
export interface TaskDetail {
  id: string; rev?: number; state: string; goal?: string; title?: string; fullTitle?: string;
  executor?: string | null; repo?: { key: string; label: string } | null; branch?: string | null; base?: string | null;
  machine?: string | null; startedAt?: number | null; endedAt?: number | null; worktree?: string | null; kind?: string | null;
  acceptance?: { state?: string; cmd?: string; summary?: string; durationS?: number; machine?: string | null } | null;
  routing?: { why?: string | null; skipped?: { executor: string; reason: string }[] } | null;
  cost?: { executor?: { account: string; deltaPct: number | null; window: string | null; reason?: string } | null } | null;
  summary?: string | null;
  files?: { path: string; status: string; added: number | null; removed: number | null; binary?: boolean }[];
  retryOptions?: { id: string; state: string; reason?: string }[];
  timeline?: { at: number; text: string }[];
  review?: { accepted: boolean } | null; resolved?: string | null; dismissed?: boolean; retriedBy?: string | null;
  progress?: { phase?: string; files?: number; commits?: number; lastOutputAt?: number | null } | null;
}

/** Settings resources, loaded through API ops when a section is opened. */
export interface SettingsData {
  config?: Resource<{ keys: Record<string, { value: unknown; source: string }>; planners: string[] }>;
  accounts?: Resource<SettingsAccount[]>;
  routing?: Resource<{ rules: { kinds?: string[]; executors: string[] }[]; available: string[] }>;
  projects?: Resource<ProjectStrategy[]>;
  strategies?: Resource<{ name: string; active: boolean; summary: string; description?: string }[]>;
  update?: Resource<{ current: string; latest: string | null; available: boolean; error?: string; disabled?: boolean }>;
  notifications?: Resource<{ level: string }>;
}
export interface SettingsAccount {
  name: string; kind: string; label?: string; source?: string; runners?: string[]; executors?: string[];
  locked?: string; signedIn?: boolean | null; signin_command?: string;
}
export interface ProjectStrategy {
  repo: { key: string; label: string; path?: string }; rev: number; executors: string[] | null;
  available: { id: string; reference: string; label: string }[];
}

export interface DashData {
  details: ReadonlyMap<string, Resource<TaskDetail>>;
  settings: SettingsData;
}

export interface ScreenCtx {
  s: ClientSnapshot;
  now: number;
  theme: TerminalTheme;
  state: UiState;
  /** Body width in cells (terminal width minus gutters). */
  width: number;
  /** Body height in lines. */
  height: number;
  wide: boolean;
  supports(op: string): boolean;
  data: DashData;
  /** Display time zone; tests pin UTC so goldens do not depend on the host. */
  timeZone?: string;
  /** Spinner frame while loading; absent when motion is off. */
  spinner?: string;
}

/** A body row; `item` marks a selectable row by item id. */
export interface Row { line: Line; item?: string; /** A continuation line of a two-line row: selected with it, without a second marker. */ cont?: boolean }
export interface ScreenView {
  /** The list pane (or the only pane). */
  list: Row[];
  /** Detail pane: right of the list when wide, a drill-in when narrow. */
  detail?: Row[];
  /** List pane width when two panes are shown. */
  listWidth?: number;
  items: Item[];
  /** Screen-level key hints shown after the selected row's actions. */
  hints?: string[];
  /** Settings sections, for the section list. */
  sections?: string[];
  /** Task ids whose `task.get` detail this view shows. */
  needs?: string[];
  /** The row selected when nothing is. */
  initial?: string;
  /** Settings resources this view shows. */
  settingsNeeds?: (keyof SettingsData)[];
}
