import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activateView, ViewVisibility } from '../../app/src/workspace/view-host';
import { useViewPosition } from '../../app/src/workspace/activation';
import { ViewActive, WorkspaceIdentity, WorkspaceScope, useWorkspaceKey, useWorkspaceState } from '../../app/src/workspace/state';
import { workspaceKey } from '../../app/src/workspace/manager';
import { TaskContext, useQuery } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';
const fixture = { navigate: (_id: string) => {}, revise: () => {}, calls: [] as string[], unmounted: [] as string[] };
const api = { hello: async () => ({}) as never, snapshot: async () => ({}) as never, call: async <T,>(_op: string, params: unknown) => { fixture.calls.push((params as { id: string }).id); return { text: 'cached content' } as T; } };
function Content({ id }: { id: string }) {
 const [draft, setDraft] = useWorkspaceState(useWorkspaceKey(id), 'draft:thread', '');
 const query = useQuery<{ text: string }>('task.get', { id });
 useLayoutEffect(() => () => { fixture.unmounted.push(id); }, []);
 return <><h1 tabIndex={-1}>Heading {id}</h1><textarea data-focus-id="draft" id={`draft-${id}`} value={draft} onInput={event => setDraft(event.currentTarget.value)}/><p>{query.data?.text}</p><details id={`card-${id}`}><summary>Expanded card</summary>Details</details><div data-scroll-id="content" id={`scroll-${id}`} style="height:100px;overflow:auto"><div style="height:800px">scroll content</div></div></>;
}
function Hosted({ id, active }: { id: string; active: boolean }) {
 const scope = workspaceKey('fixture', id);
 useViewPosition(scope, active);
 return <WorkspaceScope.Provider value={scope}><ViewActive.Provider value={active}><ViewVisibility active={active}><div data-workspace-root={scope}><Content id={id}/></div></ViewVisibility></ViewActive.Provider></WorkspaceScope.Provider>;
}
function App() {
 const [id, setId] = useState('a'), [revision, setRevision] = useState(0), views = useRef<{key:string;route:string}[]>([]);
 fixture.navigate = setId; fixture.revise = () => setRevision(n => n + 1);
 views.current = activateView(views.current, id, id);
 const state = { ...initialState(), connected: true, invalidations: { 'project-strategies': revision } };
 return <TaskContext.Provider value={{ api, state }}><WorkspaceIdentity.Provider value="fixture"><div className="pc-work"><main id="main-content">{views.current.map(view => <Hosted key={view.key} id={view.key} active={view.key === id}/>)}</main></div></WorkspaceIdentity.Provider></TaskContext.Provider>;
}
(window as any).viewFixture = fixture;
render(<App/>, document.getElementById('app')!);
