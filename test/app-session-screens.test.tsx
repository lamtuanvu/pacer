import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { Session, type SessionData } from '../app/src/screens/session/Session';
import { SessionsList } from '../app/src/screens/session/SessionsList';
import fixture from './fixtures/ui/session.json';

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
 for(const word of [data.goal,'codex#team','pacer/t-0415','this Mac','started 11:49','Testing · 14m','Changes so far','Brief','Watch it elsewhere','Done when','Timeline','Stop and retry on','pacer attach t-0415'])expect(html).toContain(word);
 expect(html.indexOf('Watch it elsewhere')).toBeLessThan(html.indexOf('Done when'));expect(html).toContain('aria-label="Codex"');expect(html).not.toContain('pc-btn--primary');});
test('Orca host offers Open in Orca and no terminal control',()=>{const html=renderToString(<Session data={{...data,session:{...data.session!,host:'orca'}}}/>);expect(html).toContain('This session runs in Orca');expect(html).toContain('Open in Orca');expect(html).not.toContain('Take control');});
test('none host renders escaped plain log; tabs render their resources',()=>{expect(renderToString(<Session data={{...data,session:{...data.session!,host:'none'},log:{data:'<script>bad</script>'}}}/>)).toContain('&lt;script>');expect(renderToString(<Session data={data} initialTab="brief"/>)).toContain('Split the store;');expect(renderToString(<Session data={data} initialTab="changes"/>)).toContain('diff --git');});
test('loading, errors and empty resources are explicit',()=>{expect(renderToString(<Session loading/>)).toContain('Loading session');expect(renderToString(<Session error="Offline"/>)).toContain('Offline');expect(renderToString(<Session/>)).toContain('Session not found');const html=renderToString(<Session data={{...data,timeline:{error:'Timeline unavailable'},doneWhen:{},brief:{loading:true}}} initialTab="brief"/>);expect(html).toContain('Timeline unavailable');expect(html).toContain('No done-when command');expect(html).toContain('Loading brief');});
test('Sessions list shows running plus recently ended Replay and section states',()=>{const html=renderToString(<SessionsList running={{data:[data]}} recent={{data:[{...data,id:'t-ended',state:'done'}]}}/>);expect(html).toContain('Running');expect(html).toContain('Recently ended');expect(html).toContain('Replay');expect(html).toContain('#/sessions/t-ended');expect(renderToString(<SessionsList running={{loading:true}} recent={{error:'Unavailable'}}/>)).toContain('Unavailable');expect(renderToString(<SessionsList/>)).toContain('No running sessions');});

test('read-only terminal exposes size, accessible status and screen reader toggle; control capability gates take',async()=>{
 const { TerminalView }=await import('../app/src/term/term');
 const html=renderToString(<TerminalView id="t-0415" cols={120} rows={36} control={false}/>);
 expect(html).toContain('Nothing you type reaches the agent.');expect(html).toContain('120×36');expect(html).toContain('Screen reader');expect(html).not.toContain('Take control');
 expect(renderToString(<TerminalView id="t-0415" control/>)).toContain('Take control');
 expect(renderToString(<TerminalView id="t-0415" control live={false}/>)).not.toContain('Take control');
});

test('unavailable attach targets, retry states and resource empties use service words',()=>{
 const html=renderToString(<Session data={{...data,session:{...data.session!,targets:[]},retryOptions:[{...data.retryOptions![0]!,available:false,reason:'No free slot'}],timeline:{data:[]},doneWhen:{error:'Command unavailable'}}}/>);
 expect(html).toContain('Open in Orca terminal · unavailable');expect(html).toContain('Open in my terminal · unavailable');expect(html).toContain('No free slot');expect(html).toContain('No timeline events yet.');expect(html).toContain('Command unavailable');
});

test('Sessions list uses short titles and ended outcomes or diffstats, reserving pending for running',()=>{
 const ended={...data,id:'ended',title:'Short title',goal:'Long instructions that belong in Brief',state:'failed',phase:undefined,changesSummary:undefined};
 const html=renderToString(<SessionsList running={{data:[]}} recent={{data:[ended,{...ended,id:'diff',changesSummary:'3 files · +12 −4'}]}}/>);
 expect(html).toContain('Short title');expect(html).not.toContain(ended.goal);expect(html).toContain('Failed');expect(html).toContain('3 files · +12 −4');expect(html).not.toContain('Changes and output pending');
 expect(renderToString(<SessionsList running={{data:[{...data,changesSummary:undefined}]}}/>)).toContain('Changes and output pending');
});
test('takeover stays visible with the service refusal reason',()=>{
 const html=renderToString(<Session data={{...data,session:{...data.session!,host:'none',takeover:{available:false,reason:'No agent session id'}}}}/>);
 expect(html).toMatch(/disabled[^>]*title="No agent session id"|title="No agent session id"[^>]*disabled/);
 expect(html).toContain('Take over');
});
test('driving header and terminal explain hand back',async()=>{
 const html=renderToString(<Session data={{...data,phase:'driving',session:{...data.session!,driving:true}}}/>);
 expect(html).toContain('>Driving<');expect(html).toContain("You're driving · keystrokes go to the agent");expect(html).not.toContain('Take over');
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
 expect(renderToString(<Session data={{...data,phase:'driving'}}/>)).toContain('>Driving<');
 expect(renderToString(<Session data={{...data,phase:undefined,session:{...data.session!,driving:true}}}/>)).toContain('>Driving<');
});

test('ended Sessions rows show their state once and retain a known diffstat at either width', () => {
 for (const narrow of [false, true]) {
  const ended = { ...data, state: 'done', phase: undefined, changesSummary: undefined };
  const html = renderToString(<div className={narrow ? 'pc-app--narrow' : 'pc-app'}><SessionsList recent={{data:[ended]}}/></div>);
  expect(html.match(/>Done</g)).toHaveLength(1);
  expect(html).not.toContain('Changes and output pending');
  const withDiff = renderToString(<SessionsList recent={{data:[{...ended,changesSummary:'3 files · +12 −4'}]}}/>);
  expect(withDiff).toContain('3 files · +12 −4');
  expect(withDiff.match(/>Done</g)).toHaveLength(1);
 }
});

test('Sessions pills override their default top alignment for running and ended rows', async () => {
 const html = renderToString(<SessionsList running={{data:[data]}} recent={{data:[{...data,id:'ended',state:'done'}]}}/>);
 expect(html.match(/class="pc-sessions-rows"/g)).toHaveLength(2);
 const css = await Bun.file(new URL('../app/src/screens/session/session.css', import.meta.url)).text();
 expect(css).toMatch(/\.pc-sessions-rows \.pc-pill\s*\{[^}]*align-self:center/);
});

test('headless sessions explain the run and offer one prominent takeover action without watch options', () => {
 const headless: SessionData = {...data,session:{...data.session!,host:'none',live:false,targets:[],takeover:{available:true}},log:{data:'<script>plain output</script>'}};
 const html = renderToString(<Session data={headless} onTakeover={()=>{}}/>);
 expect(textContent(html)).toContain('This run is headless — Take over to work in it live');
 expect(html).toMatch(/class="[^"]*pc-btn--primary[^"]*">Take over<\/button>/);
 expect(html.match(/>Take over<\/button>/g)).toHaveLength(1);
 expect(html).toContain('&lt;script>plain output&lt;/script>');
 for (const text of ['Watch it elsewhere','Open in Orca terminal','Open in my terminal','pacer attach','no terminal recording',' · unavailable']) expect(html).not.toContain(text);
});

test('live and recorded sessions retain watch options without the headless explanation', () => {
 for (const live of [true, false]) {
  const html = renderToString(<Session data={{...data,session:{...data.session!,live}}} onAttach={async()=>({opened:true})}/>);
  expect(html).toContain('Watch it elsewhere');
  expect(html).toContain('>Open in Orca terminal</button>');
  expect(html).toContain('>Open in my terminal</button>');
  expect(html).toContain('pacer attach t-0415');
  expect(html).not.toContain('This run is headless');
 }
});


test('missing sessions do not advertise watch-elsewhere options', () => {
 const html = renderToString(<Session data={{...data,session:undefined}}/>);
 expect(html).toContain('Session unavailable.');
 expect(html).not.toContain('Watch it elsewhere');
 expect(html).not.toContain('pacer attach');
});
