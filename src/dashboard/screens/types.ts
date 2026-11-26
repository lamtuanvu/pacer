import type { ClientSnapshot } from "../../view-model/snapshot";
import type { Line } from "../frame";
import type { Item, UiState } from "../state";
import type { TerminalTheme } from "../theme";

/** A fetched resource: the last value stays visible while a refresh runs. */
export interface Resource<T> { value?: T; error?: { message: string; hint?: string; code?: string }; loading?: boolean }

/** `task.get` fields the TUI reads; every field is optional so older services still render. */
export interface TaskDetail {
  work?: {rootId:string;parentId:string|null;depth:number;allowDelegation?:boolean;userStarted?:boolean};
  managedSkip?: {reason:string};
  workTree?: {nodes:{taskId:string;depth:number;title:string;state:string;model:string|null;actualModel:string|null;dependencies:string[];review:{accepted:boolean}|null;retryEligibility?:{allowed:boolean;reason?:string};attempts:{model?:string|null;actualModel?:string|null}[];decisions:{attempt:number;engine:{id:string};fallback?:{reason:string};selectedCandidateId?:string;proposal?:{state:string;choices?:{id:string;reason:string}[]}}[]}[];totals:{tasks:number;running:number;queued:number;executionSeconds:number;dependencyWaitSeconds:number|null;childWaitSeconds:number|null;capacityWaitSeconds:number|null;usagePools:{account:string;observedDeltaPct:number|null;unknownAttempts:number}[]}};
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
  reviewRequest?: {note:string;at:number};
  question?: {text:string;answer?:string};
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
  update?: Resource<UpdateInfo>;
  notifications?: Resource<{ level: string; sound: string }>;
}
export interface SettingsAccount {
  name: string; kind: string; label?: string; source?: string; runners?: string[]; executors?: string[];
  locked?: string; signedIn?: boolean | null; signin_command?: string;
}
export interface ProjectStrategy {
  repo: { key: string; label: string; path?: string }; rev: number; executors: string[] | null;
  available: { id: string; reference: string; label: string }[];
}

/** A run row from `run.list` / `run.get` (camelCase as returned by the service). */
export interface RunSummary {
  id: string;
  workflow: string;
  version: number;
  title: string;
  status: string;
  rev: number;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  auto?: boolean;
  priority?: string;
  letter?: string;
  orchestratorTaskId?: string;
  orchestrator?: { state: string; planner?: string; reason?: string; next_wake_at?: number };
}
export interface RunStepRow {
  runId: string;
  stepId: string;
  attempt: number;
  branch?: string;
  taskId?: string;
  status: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
  trigger?: string;
}
export interface RunGraphSummary {
  stepId: string;
  attempt: number;
  version: number;
  status: string;
  stepCount: number;
}
/** Additive `run.get` graph projection (types + edges); clients must not invent parentage. */
export interface RunDefinitionSummary {
  entry: string;
  edges: Array<{ from: string; to: string; when?: string; maxLoops?: number }>;
  steps: Record<string, { type: string; branches?: string[] }>;
}
export interface RunPendingApproval {
  stepId: string;
  attempt: number;
  version: number;
  replanSummary?: string;
}
export interface RunQuestion {
  id: string;
  runId: string;
  stepId?: string;
  /** Step attempt the question belongs to (from `question.list` / attention). */
  attempt?: number;
  branch?: string;
  text: string;
  answerType: string;
  options?: { value: string; note?: string }[];
  recommended?: string;
  blocks: string;
  status: string;
  answerer: string;
  rev: number;
  answer?: string;
  note?: string;
}
export interface RunDecision {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  actor: string;
  kind: string;
  choice: string;
  reason: string;
  at: number;
}
export interface RunDetail {
  run: RunSummary;
  steps: RunStepRow[];
  graphs: RunGraphSummary[];
  definition?: RunDefinitionSummary;
  pendingApproval?: RunPendingApproval;
  questions?: RunQuestion[];
  decisions?: RunDecision[];
}

export interface DashData {
  details: ReadonlyMap<string, Resource<TaskDetail>>;
  history?: Resource<{tasks: import("../../view-model/snapshot").ClientTask[]; next:string|null}>;
  settings: SettingsData;
  /** Live runs from `run.list` (Phase 8). `stamp` is snapshot.seq. */
  runs?: Resource<RunSummary[]> & { stamp?: string };
  /** `run.get` (+ questions) keyed by run id. */
  runDetails?: ReadonlyMap<string, Resource<RunDetail> & { stamp?: string }>;
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

/** The `update.check` result. */
export interface UpdateInfo { current: string; latest: string | null; available: boolean; error?: string; disabled?: boolean; managedBy?: "desktop" | "homebrew" | "npm"; managedHint?: string }
