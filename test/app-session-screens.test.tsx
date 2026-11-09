import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { Session, type SessionData } from '../app/src/screens/session/Session';
import { SessionsList } from './fixtures/ui/sessions-list';
import { conversationChanges, sessionChangeText } from '../app/src/screens/session/controller';
import fixture from './fixtures/ui/session.json';
import { taskTree, type TreeTask } from '../src/view-model/task-tree';

const node=(task:Partial<TreeTask>&{id:string;state:string})=>taskTree({tasks:[{goal:'Fix the flaky retry test',executor:'codex',backend:null,worktree:null,updatedAt:1799999000,host:null,...task} as TreeTask]},{now:1800000000})[0]!;

// Extract text for assertions without decoding entities into < or >.
function textContent(html: string): string {
  let text = '';
  let inTag = false;
  for (const char of html) {
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
    } else if (!inTag) {
      text += char;
    }
  }
  return text;
}

const data=fixture as SessionData;
test('Session board preserves layout, copy, service actions and metadata',()=>{const html=renderToString(<Session data={data}/>);
 expect(html).toContain('pc-page--full');expect(html).toContain('aria-label="Breadcrumb"');
 for(const word of [data.goal,'codex#team','pacer/t-0415','this Mac','started 11:49','Testing','Changes','Brief','Session access','Activity','Stop and retry…','pacer attach t-0415'])expect(html).toContain(word);
 expect(html.indexOf('Activity')).toBeLessThan(html.indexOf('Session access'));expect(html).toContain('aria-label="Codex"');expect(html).not.toContain('pc-btn--primary');});
test('Orca host offers Open in Orca and no terminal control',()=>{const html=renderToString(<Session data={{...data,session:{...data.session!,host:'orca'}}}/>);expect(html).toContain('This session runs in Orca');expect(html).toContain('Open in Orca');expect(html).not.toContain('Take control');});
test('none host renders escaped plain log; tabs render their resources',()=>{expect(renderToString(<Session data={{...data,session:{...data.session!,host:'none'},log:{data:'<script>bad</script>'}}}/>)).toContain('&lt;script>');expect(renderToString(<Session data={data} initialTab="brief"/>)).toContain('Split the store;');expect(renderToString(<Session data={data} initialTab="changes"/>)).toContain('diff --git');});
test('task Changes uses the v3 patch field and embedded views do not point to hidden tabs',()=>{
 const changes=sessionChangeText({patch:'diff --git a/example b/example',untracked:['new.txt'],truncated:false});
 expect(changes).toContain('diff --git a/example b/example');expect(changes).toContain('new.txt');expect(changes).not.toContain('undefined');
 expect(conversationChanges({patch:'diff --git a/example b/example',untracked:['new.txt'],truncated:false})).toEqual({diff:'diff --git a/example b/example',untracked:['new.txt']});
 const html=renderToString(<Session embedded view="changes" data={{...data,changes:{data:changes}}}/>);
 expect(html).toContain('diff --git a/example b/example');expect(html).not.toContain('aria-labelledby="session-t-0415-changes-tab"');expect(html).not.toContain('Session access');
});
test('loading, errors and empty resources are explicit',()=>{expect(renderToString(<Session loading/>)).toBe('');expect(renderToString(<Session error="Offline"/>)).toContain('Offline');expect(renderToString(<Session/>)).toContain('Session not found');const html=renderToString(<Session data={{...data,timeline:{error:'Timeline unavailable'},doneWhen:{},brief:{loading:true}}} initialTab="brief"/>);expect(html).toContain('Timeline unavailable');expect(html).toContain('No done-when command');expect(html).not.toContain('Loading brief');});
test('Sessions list opens each task through its title link',()=>{const html=renderToString(<SessionsList running={{data:[node({id:'t-0415',state:'running'})]}} recent={{data:[node({id:'t-ended',state:'done'})]}}/>);expect(html).toContain('Running');expect(html).toContain('Completed');expect(html).toContain('href="#/workspace?task=t-0415"');expect(html).not.toContain('View result');expect(html).toContain('#/workspace?task=t-ended');expect(renderToString(<SessionsList running={{loading:true}} recent={{error:'Unavailable'}}/>)).toContain('Unavailable');expect(renderToString(<SessionsList/>)).toContain('No running sessions');});

test('read-only terminal exposes size, accessible status and screen reader toggle; control capability gates take',async()=>{
 const { TerminalView, TerminalControls }=await import('../app/src/term/term');
 const html=renderToString(<TerminalView id="t-0415" cols={120} rows={36} control={false}/>);
 expect(html).toContain('Nothing you type reaches the agent.');expect(html).toContain('120×36');expect(html).toContain('Screen reader');expect(html).not.toContain('Take control');
 expect(renderToString(<TerminalView id="t-0415" control/>)).not.toContain('Take control');
 expect(renderToString(<TerminalView id="t-0415" control live={false}/>)).not.toContain('Take control');
 const state={status:'connecting' as const,you:false,controller:null,cols:120,rows:36,viewers:1};
 expect(renderToString(<TerminalControls control live state={state} onControl={()=>{}}/>)).not.toContain('Take control');
 expect(renderToString(<TerminalControls control live state={{...state,status:'live'}} onControl={()=>{}}/>)).toContain('Take control');
});

test('unavailable attach targets, retry states and resource empties use service words',()=>{
 const html=renderToString(<Session data={{...data,session:{...data.session!,targets:[]},retryOptions:[{...data.retryOptions![0]!,available:false,reason:'No free slot'}],timeline:{data:[]},doneWhen:{error:'Command unavailable'}}} initialTab="brief"/>);
 expect(html).not.toContain('>Open in Orca terminal');expect(html).not.toContain('>Open in my terminal');expect(html).toContain('>Stop and retry…</button>');expect(html).toContain('No timeline events yet.');expect(html).toContain('Command unavailable');
});

test('Sessions list uses short titles and measured diffstats, with no placeholder for missing changes',()=>{
 const ended={id:'ended',title:'Short title',goal:'Long instructions that belong in Brief',state:'failed'};
 const html=renderToString(<SessionsList running={{data:[]}} recent={{data:[node(ended),node({...ended,id:'diff',diffstat:{files:3,added:12,removed:4}})]}}/>);
 expect(html).toContain('Short title');expect(html).not.toContain(ended.goal);expect(html).toContain('Failed');expect(html).toContain('3 files · +12 −4');expect(html).not.toContain('Changes and output pending');
 expect(renderToString(<SessionsList running={{data:[node({id:'r',state:'running'})]}}/>)).not.toContain('Changes and output pending');
});

test('takeover stays visible with the service refusal reason',()=>{
 const html=renderToString(<Session data={{...data,session:{...data.session!,host:'none',takeover:{available:false,reason:'No agent session id'}}}}/>);
 expect(html).toMatch(/disabled[^>]*title="No agent session id"|title="No agent session id"[^>]*disabled/);
 expect(html).toContain('Take over');
});
test('driving header and terminal explain hand back',async()=>{
 const html=renderToString(<Session data={{...data,phase:'driving',session:{...data.session!,driving:true}}}/>);
 expect(html).toContain(">You're driving<");expect(html).toContain("You're driving · keystrokes go to the agent");expect(html).not.toContain('Take over');
 const {TerminalView}=await import('../app/src/term/term');
 const {TerminalControls}=await import('../app/src/term/term');
 const terminal=renderToString(<TerminalControls control live driving state={{status:'live',you:true,controller:'app',cols:120,rows:40,viewers:1}} onControl={()=>{}}/>);
 expect(terminal).toContain('Hand back');expect(terminal).toContain('Ends this session and sends the task to review');
});
test('takeover startup and timeout keep progress and retry visible',()=>{
 expect(renderToString(<Session data={data} takeoverStarting takeoverBusy/>)).toContain('Starting interactive session…');
 const html=renderToString(<Session data={data} takeoverError="Interactive session did not start within 30 seconds." onTakeover={()=>{}}/>);
 expect(html).toContain('role="alert"');expect(html).toContain('Try again');
 const builtin=renderToString(<Session data={{...data,session:{...data.session!,takeover:{available:false,reason:'Already interactive'}}}}/>);
 expect(builtin).toContain('title="Already interactive"');
 expect(renderToString(<Session data={{...data,phase:'driving'}}/>)).toContain(">You're driving<");
 expect(renderToString(<Session data={{...data,phase:undefined,session:{...data.session!,driving:true}}}/>)).toContain(">You're driving<");
});

test('ended Sessions rows show their state once and retain a known diffstat at either width', () => {
 for (const narrow of [false, true]) {
  const ended = node({ id: 'ended', state: 'done' });
  const html = renderToString(<div className={narrow ? 'pc-app--narrow' : 'pc-app'}><SessionsList recent={{data:[ended]}}/></div>);
  expect(html.slice(html.indexOf('<article')).match(/>Completed</g)).toHaveLength(1);
  const withDiff = renderToString(<SessionsList recent={{data:[node({ id: 'ended', state: 'done', diffstat:{files:3,added:12,removed:4} })]}}/>);
  expect(withDiff).toContain('3 files · +12 −4');
  expect(withDiff.slice(withDiff.indexOf('<article')).match(/>Completed</g)).toHaveLength(1);
 }
});

test('Sessions list renders running and ended work as labelled task trees', () => {
 const html = renderToString(<SessionsList running={{data:[node({id:'r',state:'running'})]}} recent={{data:[node({id:'ended',state:'done'})]}}/>);
 expect(html).toContain('aria-label="Running tasks"');
 expect(html).toContain('aria-label="Completed tasks"');
 expect(html.match(/pc-task-card--regular/g)).toHaveLength(2);
});

test('headless sessions explain the run and offer one prominent takeover action without watch options', () => {
 const headless: SessionData = {...data,session:{...data.session!,host:'none',live:false,targets:[],takeover:{available:true}},log:{data:'<script>plain output</script>'}};
 const html = renderToString(<Session data={headless} onTakeover={()=>{}}/>);
 expect(textContent(html)).toContain('This run is headless — Take over to work in it live');
 expect(html).toMatch(/class="[^"]*pc-btn--primary[^"]*">Take over<\/button>/);
 expect(html.match(/>Take over<\/button>/g)).toHaveLength(1);
 expect(html).toContain('&lt;script>plain output&lt;/script>');
 for (const text of ['Session access','Open in Orca terminal','Open in my terminal','pacer attach','no terminal recording',' · unavailable']) expect(html).not.toContain(text);
});

test('live and recorded sessions retain watch options without the headless explanation', () => {
 for (const live of [true, false]) {
  const html = renderToString(<Session data={{...data,session:{...data.session!,live}}} onAttach={async()=>({opened:true})}/>);
  expect(html).toContain('Session access');
  expect(html).toContain('>Open in Orca terminal</button>');
  expect(html).toContain('>View in Pacer</button>');
  expect(html).toContain('pacer attach t-0415');
  expect(html).not.toContain('This run is headless');
 }
});


test('missing sessions do not advertise watch-elsewhere options', () => {
 const html = renderToString(<Session data={{...data,session:undefined}}/>);
 expect(html).toContain('Session unavailable.');
 expect(html).not.toContain('Session access');
 expect(html).not.toContain('pacer attach');
});


test('session task title uses normal-case page typography and prefers the service title', async () => {
 const html = renderToString(<Session data={{...data,title:'Fix add() in calc.py'}}/>);
 expect(html).toMatch(/<h2(?=[^>]*class="pc-session-title")(?=[^>]*title="Fix add\(\) in calc.py")[^>]*>Fix add\(\) in calc.py<\/h2>/);
 expect(html).not.toContain(data.goal);
 expect(renderToString(<Session data={data}/>)).toContain(`title="${data.goal}"`);
 const css = await Bun.file(new URL('../app/src/screens/session/session.css', import.meta.url)).text();
 expect(css).toMatch(/\.pc-session-title\s*\{[^}]*font-size:var\(--type-headline-size\)/);
 expect(css.match(/\.pc-session-title\s*\{[^}]*\}/)?.[0]).not.toContain('uppercase');
});

test('ended headless sessions show their outcome and Review or Retry without live controls', () => {
 for (const state of ['done', 'partial', 'failed', 'stopped', 'limit']) {
  const ended: SessionData = {...data,state,changesSummary:undefined,session:{...data.session!,host:'none',live:true,driving:true,takeover:{available:true}}};
  const html = renderToString(<Session data={ended} onTakeover={()=>{}} takeoverStarting takeoverError="Stale takeover error"/>);
  expect(html).not.toContain('This run has finished');
  expect(html).toContain('>Retry session…</button>');
  for (const text of ['Take over','Stop and retry','>Stop<','Changes and output pending','Testing · 14m',">Driving<",'Starting interactive session','Stale takeover error']) expect(html).not.toContain(text);
  if (['done','partial'].includes(state)) {
   expect(html).toContain(state==='done'?'Completed':'Incomplete');
   expect(html).not.toContain('href="#/review/t-0415"');
  } else {
   expect(html).not.toContain('>Review</a>');
  }
 }
});

test('reviewed and resolved sessions do not offer another review', () => {
 for (const extra of [{review:{accepted:true}}, {review:{accepted:false}}, {resolved:'handled'}, {dismissed:true}, {retriedBy:'next'}]) {
  const html=renderToString(<Session data={{...data,state:'done',changesSummary:undefined,...extra}}/>);
  expect(html).not.toContain('Waiting for review');
  expect(html).not.toContain('>Review</a>');
  expect(html).not.toContain('Changes and output pending');
  if (extra.review) expect(html).toContain(extra.review.accepted?'Accepted':'Rejected');
 }
});

test('running headless takeover occupies its own area outside the explanatory sentence', () => {
 const html=renderToString(<Session data={{...data,session:{...data.session!,host:'none',takeover:{available:true}}}} onTakeover={()=>{}}/>);
 expect(html).toMatch(/<div class="pc-session-run"><p>This run is headless — Take over to work in it live<\/p><span class="pc-control-with-reason"><button/);
 expect(html).toContain('>Stop</button>');
 expect(html).toContain('Stop and retry…');
});

test('ended task link preserves route query and accessible title', async () => {
 const html=renderToString(<SessionsList recent={{data:[node({id:'ended task',state:'done',title:'Finished task'})]}} query="repo=project"/>);
 expect(html).toContain('pc-task-card__title');
 expect(html).toContain('title="Finished task"');
 expect(html).toContain('href="#/workspace?task=ended%20task&amp;repo=project"');
 expect(html).not.toContain('View result');
});

test('session adapters preserve review outcome and suppression fields', async () => {
 const {sessionRow}=await import('../app/src/screens/session/controller');
 const task={id:'ended',goal:'Finished',state:'done',executor:'codex',backend:null,worktree:null,updatedAt:0,review:{accepted:true,kind:null,note:null,at:1},resolved:'handled',dismissed:true,retriedBy:'retry'};
 expect(sessionRow(task)).toMatchObject({review:task.review,resolved:'handled',dismissed:true,retriedBy:'retry'});
});

test('session detail maps and deduplicates timeline events with raw copy collapsed', async () => {
 const {sessionDetail}=await import('../app/src/screens/session/controller');
 const detail=(await import('./fixtures/ui/task-get.json')).default;
 const model=sessionDetail({...detail,branch:null,timeline:[{at:1,text:'hook: PostToolUse'},{at:1,text:'hook: PostToolUse'},{at:2,text:'Testing'},{at:3,text:'partial'}]} as unknown as import('../src/core/task-detail').TaskDetail);
 const html=renderToString(<Session data={model}/>);
 const visible=html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
 expect(visible).toContain('Branch not recorded');
 expect(visible).toContain('Running checks');
 expect(visible).toContain('Run ended with work to review');
 expect(visible.match(/Agent finished a tool step/g)).toHaveLength(1);
 expect(visible).not.toContain('hook:');
 expect(html).toContain('<summary>Technical event details</summary>');
 expect(html).not.toMatch(/<details[^>]*\bopen\b/);
});

test('finished sessions open a readable brief, while active sessions keep live output selected', () => {
 const finished = renderToString(<Session data={{...data,state:'done'}}/>);
 expect(finished).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Brief</);
 expect(finished).toContain('Split the store;');
 const live = renderToString(<Session data={data}/>);
 expect(live).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Output</);
});

test('structured brief preserves multiline instructions, command and extra context without flattening', () => {
 const html = renderToString(<Session data={{...data,state:'done',briefSections:[{label:'Goal',text:'Fix checks'},{label:'Scope',text:'Line one\nLine two'},{label:'Context',text:'<script>unsafe</script>'}]}}/>);
 expect(html).toContain('>Goal</h3>');
 expect(html).toContain('Line one\nLine two');
 expect(html).toContain('&lt;script>unsafe&lt;/script>');
 expect(html.match(/bun test test\/usage/g)).toHaveLength(1);
 expect(html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'')).not.toContain('Split the store;');
});

test('executor report is formatted separately from collapsed raw output without interpreting HTML', () => {
 const html = renderToString(<Session data={{...data,state:'done',session:{...data.session!,host:'none'},report:'Fixed **both failures**.\n\n- Kept `callbacks` working\n- <script>unsafe</script>',log:{data:'hook: Stop'}}} initialTab="terminal"/>);
 expect(html).toContain('<strong>both failures</strong>');
 expect(html).toContain('<code>callbacks</code>');
 expect(html).toContain('&lt;script>unsafe&lt;/script>');
 expect(html).toMatch(/<details[^>]*>[\s\S]*Technical session output[\s\S]*hook: Stop/);
 expect(html).not.toMatch(/<details[^>]*\bopen\b/);
});

test('retry picker is deferred until requested and a missing executor is explained', () => {
 const html = renderToString(<Session data={data} onAction={()=>{}}/>);
 expect(html).toContain('>Stop and retry…</button>');
 expect(html).not.toContain('<select');
 const unavailable = renderToString(<Session data={{...data,retryOptions:[]}}/>);
 expect(unavailable).toContain('No retry options available.');
 expect(unavailable).not.toContain('>Stop and retry…</button>');
});

test('session detail retains all brief fields and uses the actual executor report', async () => {
 const {sessionDetail}=await import('../app/src/screens/session/controller');
 const detail=(await import('./fixtures/ui/task-get.json')).default;
 const model=sessionDetail({...detail,brief:{...detail.brief,scope:'Only client code',constraints:'Keep callbacks',context:'CI run',feedback:'Check cleanup',base:'main',qa:[{q:'Which platform?',a:'Both'}]},summary:'Executor-authored report'} as unknown as import('../src/core/task-detail').TaskDetail);
 expect(model.briefSections).toEqual([
  {label:'Goal',text:'Fix flaky retry test in the payments client'},
  // Session board item 20 requires the display label, replacing the old path value.
  {label:'Repository',text:'acme/api'},
  {label:'Scope',text:'Only client code'},
  {label:'Constraints',text:'Keep callbacks'},
  {label:'Context',text:'CI run'},
  {label:'Feedback',text:'Check cleanup'},
  {label:'Base',text:'main'},
  {label:'Questions and answers',text:'Which platform?\nBoth'},
 ]);
 expect(model.report).toBe('Executor-authored report');
 expect(model.doneWhen?.data).toBe('bun test');
});

test('formatted reports preserve code blocks and unsupported markup as escaped content', async () => {
 const {Prose}=await import('../app/src/ds/Prose');
 const html=renderToString(<Prose text={'## Validation\n\n```sh\n<script>not HTML</script>\n```\n\n[jump](javascript:alert(1))\n\n```\nunfinished code'}/>);
 expect(html).toContain('>Validation</h3>');
 expect(html).toContain('<code>&lt;script>not HTML&lt;/script></code>');
 expect(html).not.toContain('<script>');
 expect(html).not.toContain('<a ');
 expect(html).toContain('[jump](javascript:alert(1))');
 expect(html).toContain('<code>unfinished code</code>');
});


test('session review action requires an explicit review request and preserves the completed outcome', () => {
 const completed={...data,state:'done'};
 expect(renderToString(<Session data={completed}/>)).not.toContain('>Review</a>');
 expect(renderToString(<Session data={{...completed,reviewRequest:{note:'Check cleanup',at:1}}}/>)).toContain('>Review</a>');
});

type Node={props?:{children?:unknown;onClick?:()=>void}};
const findButton=(node:unknown,label:string):Node|undefined=>{
 if(!node||typeof node!=='object')return undefined;
 if(Array.isArray(node))return node.map(child=>findButton(child,label)).find(Boolean);
 const props=(node as Node).props;
 if(props?.children===label&&props.onClick)return node as Node;
 return findButton(props?.children,label);
};
test('a 1.2 session has no control row: no take, release, read-only notice or takeover prompt', async () => {
 const { TerminalControls }=await import('../app/src/term/term');
 const state={status:'live' as const,you:true,controller:null,cols:120,rows:40,viewers:2,shared:true};
 for(const html of [renderToString(<TerminalControls control live state={state} onControl={()=>{}}/>),
  renderToString(<TerminalControls control live state={{...state,you:false}} onControl={()=>{}}/>)]){
  for(const word of ['Take control','Release control','Watching · read-only','Take over?','Hand back','Other viewers stay read-only'])expect(html).not.toContain(word);
 }
 expect(renderToString(<TerminalControls control live shell state={state} onControl={()=>{}}/>)).toContain('Every open window can type into this shell.');
});
test('a 1.2 takeover session hands back through its own action, not by releasing control', async () => {
 const { TerminalControls }=await import('../app/src/term/term');
 const state={status:'live' as const,you:true,controller:null,cols:120,rows:40,viewers:1,shared:true};
 let handedBack=0,released=0;
 const controls=TerminalControls({control:true,live:true,driving:true,state,onControl:()=>{released++;},onHandBack:()=>{handedBack++;}});
 const html=renderToString(controls);
 expect(html).toContain('>Hand back<');expect(html).toContain('Ends this session and sends the task to review');expect(html).not.toContain('aria-pressed');
 findButton(controls,'Hand back')!.props!.onClick!();
 expect([handedBack,released]).toEqual([1,0]);
 expect(renderToString(<TerminalControls control live driving state={state} onControl={()=>{}}/>)).not.toContain('Hand back');
 const busy=renderToString(<TerminalControls control live driving handingBack state={state} onControl={()=>{}} onHandBack={()=>{}}/>);
 expect(busy).toMatch(/<button[^>]*disabled[^>]*>/);
});
test('a 1.1 takeover still hands back by releasing control', async () => {
 const { TerminalControls }=await import('../app/src/term/term');
 let handedBack=0,released=0;
 const controls=TerminalControls({control:true,live:true,driving:true,state:{status:'live',you:true,controller:'app',cols:120,rows:40,viewers:1,shared:false},onControl:()=>{released++;},onHandBack:()=>{handedBack++;}});
 findButton(controls,'Hand back')!.props!.onClick!();
 expect([handedBack,released]).toEqual([0,1]);
});
test('the 1.2 status names who typed last', async () => {
 const { lastInputWords, sessionActive }=await import('../app/src/term/activity');
 expect(lastInputWords(null)).toBe('Interactive');
 expect(lastInputWords('app:pacer app')).toBe('Interactive · last input from pacer app');
 expect(lastInputWords('cli:iTerm.app')).toBe('Interactive · last input from iTerm.app');
 expect(sessionActive({...data.session!,active:'cli:ghostty'})).toBe('cli:ghostty');
 expect(sessionActive(data.session)).toBeNull();
 expect(lastInputWords('app:pacer app',{kind:'answer'})).toBe('Interactive · last input from pacer app · pacer delivered an answer');
 expect(lastInputWords(null,{kind:'message'})).toBe('Interactive · pacer delivered a message');
 // F6: the app's window labels read plainly, including the per-window ordinal of a second window.
 expect(lastInputWords('app:Pacer desktop')).toBe('Interactive · last input from Pacer desktop');
 expect(lastInputWords('app:Browser · 2')).toBe('Interactive · last input from Browser · 2');
});
test('a 1.2 interactive session renders no control row with a disabled Take over, even when a takeover node is passed', async () => {
 const { TerminalControls }=await import('../app/src/term/term');
 const takeover=<span className="pc-control-with-reason"><button disabled>Take over</button><span>This task is already interactive or being taken over.</span></span>;
 const state={status:'live' as const,you:true,controller:null,cols:120,rows:40,viewers:2,shared:true};
 const html=renderToString(<TerminalControls control live state={state} takeover={takeover} onControl={()=>{}}/>);
 expect(html).not.toContain('Take over');expect(html).not.toContain('already interactive');
 // A 1.1 session keeps its takeover control and reason.
 expect(renderToString(<TerminalControls control live state={{...state,shared:false,you:false,controller:null}} takeover={takeover} onControl={()=>{}}/>)).toContain('Take over');
});
test('the Session screen builds no Take over for a live built-in session on a 1.2 host', async () => {
 const { sessionTakeoverShown }=await import('../app/src/screens/session/Session');
 const session={...data.session!,host:'builtin' as const,live:true,takeover:{available:false,reason:'This task is already interactive or being taken over.'}};
 expect(sessionTakeoverShown({...session,sessionMinor:2})).toBe(false);
 expect(sessionTakeoverShown({...session,sessionMinor:1})).toBe(true);
 expect(sessionTakeoverShown({...session,host:'none'})).toBe(true);
});
test('the terminal pane is named after its agent and whether it types', async () => {
 const { TerminalView }=await import('../app/src/term/term');
 expect(renderToString(<TerminalView id="t-0415" agent="codex" control/>)).toContain('aria-label="Codex terminal, read-only"');
 expect(renderToString(<TerminalView id="t-0415" agent="claude-code" control/>)).toContain('aria-label="Claude Code terminal, read-only"');
 expect(renderToString(<TerminalView id="t-0415" control/>)).toContain('aria-label="Agent terminal, read-only"');
 expect(renderToString(<TerminalView id="t-0415" preview control/>)).toContain('aria-label="Terminal output"');
});
