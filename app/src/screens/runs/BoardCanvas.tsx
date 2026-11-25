/** The drawing of a board: stations, zones, bands, edges, desks, the person and the agents. Used by the Live board and the playback. */
import { stepMarkerFor, stepMarkerGlyph, runStatus } from "../../../../src/view-model/runs";
import { sentenceCase } from "../../../../src/view-model/run-board";
import { Creature, PersonFigure, creatureHeight } from "./MascotArt";
import { FIGURE, GAP_X, STATION_H, STATION_W, type BoardNode, type BoardZone, type LiveBoardLayout } from "./live-board-layout";
import { graphStatusLabel, nodeLabel, shortLabel } from "./live-board-model";

/** `executor` is the identity that seeds the creature; `name` is what the screen says. */
export interface CanvasAgent { taskId: string; nodeId: string; x: number; y: number; executor: string; name: string; label: string }

/** The words a desk shows: a glyph and a status word, never colour alone (UI-2, UI-10). */
export function deskWords(n: { status: string; waitsOnYou: boolean }): { glyph: string; label: string; cls: string } {
  if (n.waitsOnYou) return { glyph: stepMarkerGlyph("waits_you"), label: "Waits on you", cls: "you" };
  if (n.status === "pending") return { glyph: stepMarkerGlyph("unknown"), label: "Not started", cls: "pending" };
  const s = runStatus(n.status);
  return { glyph: stepMarkerGlyph(stepMarkerFor({ status: n.status })), label: s.label, cls: n.status };
}

/** What a zone says about its versions: the newest version's status and size, how many of its steps started, and the one before it. */
export function zoneSummary(z: { versions: Array<{ version: number; status: string; stepCount: number }>; approved: number; drawn: number }): string {
  if (!z.versions.length) return "No plan yet";
  const latest = z.versions[z.versions.length - 1]!;
  const prev = z.versions.length > 1 ? z.versions[z.versions.length - 2]! : undefined;
  const size = `${latest.stepCount} ${latest.stepCount === 1 ? "step" : "steps"}`;
  const state = z.approved ? ` · ${z.drawn} started` : " · not approved yet";
  return `v${latest.version} ${graphStatusLabel(latest.status)} · ${size}${state}${prev ? ` · v${prev.version} ${graphStatusLabel(prev.status)}` : ""}`;
}

export interface CanvasProps {
  layout: LiveBoardLayout;
  markerId: string;
  agents: CanvasAgent[];
  plannerIdentity: string;
  plannerNote: string;
  /** Interactive agents (Live board) or plain creatures (read-only playback). */
  selectedTaskId?: string | null;
  onOpenAgent?: (taskId: string) => void;
  agentRef?: (taskId: string, el: SVGGElement | null) => void;
  /** Playback hooks: which desks exist yet, what status each shows, what each zone says. */
  visible?: (n: BoardNode) => boolean;
  statusOf?: (n: BoardNode) => { status: string; waitsOnYou: boolean };
  zoneLine?: (z: BoardZone) => string | null;
  zoneApproved?: (z: BoardZone) => boolean;
  /** Where the person stands: a visible desk id, or null for home. */
  personAt?: string | null;
  personNote?: string;
}

export function BoardCanvas(p: CanvasProps) {
  const { layout } = p;
  const visible = p.visible ?? (() => true);
  const statusOf = p.statusOf ?? ((n: BoardNode) => ({ status: n.status, waitsOnYou: n.waitsOnYou }));
  const shown = new Set(layout.nodes.filter(visible).map(n => n.id));
  const personAt = p.personAt === undefined ? layout.person.at : p.personAt;
  const person = personAt === null
    ? { x: STATION_W + GAP_X, y: 0 }
    : (() => { const n = layout.nodes.find(x => x.id === personAt); return n ? { x: n.x + n.w - FIGURE - 8, y: n.y + n.h - FIGURE - 8 } : null; })();
  const agentByNode = new Map(p.agents.map(a => [a.nodeId, a]));
  // A fan-out's band is drawn once one of its lanes (or its join) is.
  const shownBands = new Set(layout.nodes.filter(n => n.kind !== "desk" && shown.has(n.id)).map(n => `band:${n.zoneId ? `${n.zoneId}/` : ""}${n.stepId}`));
  const endShown = (id: string) => id.startsWith("band:") ? shownBands.has(id) : shown.has(id);
  return (
    <>
      <g transform={`translate(${layout.planner.x} ${layout.planner.y})`} data-station="planner">
        <rect className="lb-station-box" width={STATION_W} height={STATION_H} />
        <Creature identity={p.plannerIdentity} x={12} y={STATION_H - creatureHeight(40) - 10} size={40} planner />
        <text className="lb-station-label" x={72} y={34}>Planner</text>
        <text className="lb-station-note" x={72} y={52}>{shortLabel(p.plannerNote, 14)}</text>
      </g>
      {person && personAt === null ? (
        <g transform={`translate(${person.x} ${person.y})`} data-station="person">
          <rect className="lb-station-box" width={STATION_W} height={STATION_H} />
          <PersonFigure x={12} y={STATION_H - creatureHeight(40) - 10} size={40} />
          <text className="lb-station-label" x={72} y={34}>You</text>
          <text className="lb-station-note" x={72} y={52}>{p.personNote ?? "Nothing waits on you"}</text>
        </g>
      ) : null}
      {layout.zones.map(z => {
        const line = p.zoneLine ? p.zoneLine(z) : zoneSummary(z);
        if (line === null) return null;
        return (
          <g key={z.id} data-zone={z.id}>
            <rect className={`lb-zone${(p.zoneApproved ? p.zoneApproved(z) : z.approved > 0) ? " lb-zone--filled" : ""}`} x={z.x} y={z.y} width={z.w} height={z.h} rx="8" />
            <text className="lb-zone-label" x={z.x + 12} y={z.y + 20}>Generated plan · {shortLabel(z.stepId, 20)}</text>
            <text className="lb-zone-note" x={z.x + 12} y={z.y + 38}>{line}</text>
          </g>
        );
      })}
      {layout.bands.filter(b => shownBands.has(b.id)).map(b => (
        <g key={b.id}>
          <rect className="lb-band" x={b.x} y={b.y} width={b.w} height={b.h} rx="8" />
          <text className="lb-band-label" x={b.x + 12} y={b.y + 18}>Fan-out · {shortLabel(b.stepId, 18)} · {b.lanes} {b.lanes === 1 ? "lane" : "lanes"}</text>
        </g>
      ))}
      {layout.edges.filter(e => endShown(e.from) && endShown(e.to)).map(e => {
        const mid = Math.max(24, (e.x2 - e.x1) / 2);
        return <path key={e.id} className="lb-edge" data-edge={e.id} d={`M${e.x1} ${e.y1} C${e.x1 + mid} ${e.y1} ${e.x2 - mid} ${e.y2} ${e.x2} ${e.y2}`} markerEnd={`url(#${p.markerId}-arrow)`} />;
      })}
      {layout.nodes.filter(n => shown.has(n.id)).map(n => {
        const words = deskWords(statusOf(n));
        const agent = agentByNode.get(n.id);
        return (
          <g key={n.id} className={`lb-desk lb-desk--${words.cls}`} data-node={n.id} transform={`translate(${n.x} ${n.y})`}>
            <rect className="lb-desk-box" width={n.w} height={n.h} />
            <text className="lb-desk-label" x={10} y={22}>{shortLabel(nodeLabel(n))}</text>
            <text className="lb-desk-state" x={agent ? FIGURE + 18 : 10} y={n.h - 16}>{words.glyph} {words.label}</text>
          </g>
        );
      })}
      {person && personAt !== null ? (
        <g data-station="person" data-at={personAt}>
          <PersonFigure x={person.x} y={person.y} size={FIGURE} />
        </g>
      ) : null}
      {p.agents.filter(a => shown.has(a.nodeId)).map(a => p.onOpenAgent ? (
        <g
          key={a.taskId}
          className="lb-agent"
          data-agent={a.taskId}
          ref={(el: SVGGElement | null) => p.agentRef?.(a.taskId, el)}
          role="button"
          tabindex={0}
          aria-pressed={p.selectedTaskId === a.taskId}
          aria-label={`${a.name} working on ${a.label}. Open live output`}
          onClick={() => p.onOpenAgent!(a.taskId)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onOpenAgent!(a.taskId); } }}
        >
          <rect className="lb-agent-ring" x={a.x - 3} y={a.y - 3} width={FIGURE + 6} height={creatureHeight(FIGURE) + 6} />
          <Creature identity={a.executor} x={a.x} y={a.y} size={FIGURE} />
        </g>
      ) : (
        <g key={a.taskId} data-agent-static={a.taskId}>
          <Creature identity={a.executor} x={a.x} y={a.y} size={FIGURE} />
        </g>
      ))}
    </>
  );
}

export const plannerNoteFor = (state: string | undefined): string => state ? sentenceCase(state) : "Idle";
