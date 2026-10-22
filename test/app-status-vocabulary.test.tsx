import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import fixture from './fixtures/ui/snapshot.json';
import detail from './fixtures/ui/task-get.json';
import type { ClientSnapshot } from '../src/view-model/snapshot';
import type { TaskDetail } from '../src/core/task-detail';
import { taskStatus } from '../src/view-model/words';
import { createActionRunner } from '../app/src/data/actions';
import { createApi } from '../app/src/data/api';
import { OverviewView } from '../app/src/screens/Overview';
import { ReviewView } from '../app/src/screens/Review';
import { initialReview, reviewReducer } from '../app/src/screens/review/model';
import { sessionRow, sessionDetail } from '../app/src/screens/session/controller';
import { SessionsList } from '../app/src/screens/session/SessionsList';
import { Session } from '../app/src/screens/session/Session';
import { StatusPill } from '../app/src/ds/StatusPill';
import { TopBar } from '../app/src/shell/TopBar';
import { StatusBar } from '../app/src/shell/StatusBar';
import { createKeyRegistry } from '../app/src/keys/registry';
import { Tray } from '../app/src/tray/Tray';
import { createTrayIpc } from '../app/src/tray/ipc';

const runner = createActionRunner({call:async <T,>()=>({} as T),waitFor:async()=>true,refetch(){},navigate(){}});
const overview = (snapshot: ClientSnapshot) => renderToString(<OverviewView snapshot={snapshot} query={{repo:null,scope:null}} now={snapshot.at} runner={runner} activity={[]} ops={new Set()} />);

test('review queue and detail use task status even when acceptance has a different result', () => {
  const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
  const task = {...detail,title:detail.goal, acceptance:{...detail.acceptance,state:'failed'}} as TaskDetail;
  const item = {...snapshot.attention!.find(a=>a.kind==='review')!,taskId:task.id};
  snapshot.attention = [item]; snapshot.tasks = [task];
  const badge = renderToString(<StatusPill status={taskStatus(task)} />);
  const html = renderToString(<ReviewView snapshot={snapshot} task={task} now={snapshot.at} view={reviewReducer(initialReview,{type:'queue',items:[item]})} />);
  expect(html.split(badge)).toHaveLength(2); // Execution badge and attention reason are distinct.
  expect(overview(snapshot)).toContain('Review requested');
  expect(taskStatus(task).tone).toBe('good');
});

test('session list and detail retain review verdicts and ignore phases from ended runs', () => {
  for (const accepted of [true,false]) {
    const task = {...detail,title:detail.goal,state:'done',review:{accepted,at:0,kind:null,note:null},progress:{phase:'testing',lastOutputAt:0,files:0,commits:0,logBytes:0}} as TaskDetail;
    const badge = renderToString(<StatusPill status={taskStatus(task)} />);
    expect(renderToString(<SessionsList recent={{data:[sessionRow(task)]}} />)).toContain(badge);
    expect(renderToString(<Session data={sessionDetail(task)} />)).toContain(badge);
  }
});

test('planner, capacity and tray agree on the pace of a ready executor at 37 percent', () => {
  const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
  snapshot.planner = {...snapshot.planner!,usedPct:37,pacePct:20,verdict:'ahead'};
  snapshot.executors = [{...snapshot.executors![0]!,id:snapshot.planner.runner,state:'ready',tone:'good',usedPct:37,pacePct:20,slots:{used:0,max:1}}];
  const html = overview(snapshot);
  expect(html.match(/pc-meter__fill--warn/g)).toHaveLength(2); // Planner strip and Capacity.
  expect(html).toContain('Ahead of pace');
  const status = renderToString(<StatusBar route={{name:'overview',query:{repo:null,scope:null}}} snapshot={snapshot} registry={createKeyRegistry({controlActive:()=>false})} />);
  expect(status).toContain('pc-meter__fill--warn');
  expect(status.match(/pc-meter__fill--warn/g)).toHaveLength(1); // Planner and its executor share one reading.
  const top = renderToString(<TopBar title="Overview" planner={snapshot.planner} mode="normal" connected lastUpdate={snapshot.at} now={snapshot.at} onDelegate={()=>{}} />);
  expect(top).not.toContain('pc-meter');
  const tray = renderToString(<Tray snapshot={snapshot} api={createApi()} ipc={createTrayIpc({location:{assign(){}}})} />);
  expect(tray).toContain('pc-meter__fill--warn');
  expect(tray).toContain('Eligibility unknown · No execution decision is available · Ahead of pace');
  expect(tray).toContain('pc-status--warn">37%');
});
