import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { AccountsSection } from '../app/src/screens/settings/Accounts';
import { SettingsGeneral } from '../app/src/screens/settings/General';
import { SetupEditor } from '../app/src/screens/settings/DispatcherSetup';
import { dispatchConfigSchema } from '../src/dispatch/types';
import { costCopy, reasonCopy } from '../src/view-model/copy';
import { AgentsIntro, ExecutorsSection } from '../app/src/screens/settings/Executors';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { accountLabel } from '../src/view-model/words';
import { executorReadiness } from '../src/view-model/capacity';
import { usageView } from '../src/view-model/usage';
import { usageStateFor, withUsageState } from './usage-fixtures';
import type { ClientSnapshot } from '../src/view-model/snapshot';
import fixture from './fixtures/ui/snapshot.json';
import { settings } from './fixtures/ui/settings';

const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
const draw = (child: any, snap = snapshot) => renderToString(<TaskContext.Provider value={{state:{...initialState(),snapshot:snap},api:{} as any}}>{child}</TaskContext.Provider>);
const row = {...snapshot.executors![0]!, rank:1, enabled:true, state:'ready' as const, stale:false};
const eligible = {state:'eligible',budget:'available',reasons:[],evaluatedAt:snapshot.at,evidenceAgeS:0} as any;
const snap = {...snapshot,planner:null,executors:[{...row,eligibility:eligible}],accounts:[{...snapshot.accounts![0]!,name:row.account,executors:[row.id],stale:false,verdict:'ON_PACE',window:'week',resetsAt:null}]} as ClientSnapshot;
const visible = (html: string) => html.replace(/<span role="tooltip"[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, '');

test('all rendered budget and overview captions round fractional percentages', () => {
  const fractional = {...snap,planner:{...snapshot.planner!,usedPct:17.1456,pacePct:70.57760252101082}};
  const config = {...settings,config:{...settings.config,keys:{...settings.config.keys,'pacing.planner_reserve':{value:10.25},'pacing.fill_threshold':{value:80.25}}}};
  for (const section of ['planner','general']) {
    const html = visible(draw(<SettingsGeneral section={section} initialData={config}/>,fractional));
    expect(html).not.toMatch(/\d+\.\d+%/);
  }
  expect(draw(<SettingsGeneral section="planner" initialData={config}/>,fractional)).toContain('pace 71%');
});

test('weekly copy keeps a meter but omits compact pace and engine strings', () => {
  // The "This week" cell quotes the executor's record through usageView (ADR 0030).
  expect(usageView(usageStateFor({ usedPct: 81.45, window: 'weekly', verdict: 'ON_PACE' }, snap.at ?? 1000), snap.at ?? 1000).figure).toBe('81%');
  expect(usageView(usageStateFor({ usedPct: 81, window: 'weekly', stale: true }, snap.at ?? 1000), snap.at ?? 1000).freshness).toBe('Reading 26h old · refresh');
  expect(usageView(usageStateFor({ usedPct: null, window: 'weekly', verdict: 'UNMETERED' }, snap.at ?? 1000), snap.at ?? 1000).figure).toBe('Unmetered');
  const reset = (snap.at ?? 1800000000) + 2 * 86400; // a reset inside the next seven days keeps its weekday
  expect(usageView(usageStateFor({ usedPct: 81, window: 'weekly', resetsAt: reset, verdict: 'ON_PACE' }, snap.at ?? 1000), snap.at ?? 1000).reset).toMatch(/^resets \w{3} \d{2}:\d{2}$/);
  const html = draw(<ExecutorsSection/>, withUsageState(snap));
  expect(html).toContain('role="meter"');
  expect(visible(html)).toContain('of week');
  expect(visible(html)).not.toContain('Eligible');
  expect(visible(html)).not.toContain('Execution permitted');
});

test('readiness maps authoritative eligibility and pace with one short reason', () => {
  const ready = {...row,eligibility:eligible};
  expect(executorReadiness(ready,snap).label).toBe('Ready');
  expect(executorReadiness(ready,{...snap,accounts:[{...snap.accounts![0]!,verdict:'AHEAD'}]}).label).toBe('Ahead of pace');
  expect(executorReadiness({...ready,enabled:false},snap).label).toBe('Off');
  expect(executorReadiness({...ready,state:'full'},{...snap,accounts:[{...snap.accounts![0]!,verdict:'AHEAD'}]})).toMatchObject({label:'Skipped',reason:'All parallel slots are in use'});
  expect(executorReadiness({...ready,stale:true},snap).label).toBe('Skipped');
  expect(executorReadiness({...ready,state:'failing',recentFailures:3,reason:'engine string'},snap)).toMatchObject({label:'Ready',reason:'3 recent failures'});
  const missing = {...eligible,state:'ineligible',reasons:[{code:'subscription_missing'}]};
  expect(executorReadiness({...ready,eligibility:missing},snap)).toMatchObject({label:'Cannot take work',reason:'No active subscription'});
  expect(executorReadiness({...ready,stale:true},{...snap,accounts:[{...snap.accounts![0]!,capturedAt:snap.at-19*3600}]}).reason).toBe('Usage reading is 19h old');
  expect(executorReadiness({...ready,eligibility:undefined},snap).label).toBe('Skipped');
  expect(executorReadiness({...ready,untested:true},snap)).toMatchObject({label:'Not tested',tone:'neutral',reason:'Still takes work · run a test task to confirm'});
  expect(executorReadiness({...ready,untested:true},{...snap,accounts:[{...snap.accounts![0]!,verdict:'AHEAD'}]}).label).toBe('Not tested');
  expect(executorReadiness({...ready,untested:true,state:'full'},snap)).toMatchObject({label:'Skipped',reason:'All parallel slots are in use'});
  expect(executorReadiness({...ready,untested:true,eligibility:undefined},snap)).toMatchObject({label:'Skipped',reason:'Refresh to confirm availability'});
});

test('account labels use agent names and distinguish named accounts', () => {
  for (const [name,kind,label] of [['claude-code','claude','Claude Code'],['codex','codex','Codex'],['agy','agy','Antigravity'],['byteplus','endpoint','BytePlus'],['local','endpoint','Local model'],['claude1','claude','Claude Code · claude1']]) {
    expect(accountLabel({name:name!,kind:kind!})).toBe(label!);
  }
  const html = visible(draw(<SettingsGeneral initialData={settings}/>,{...snap,executors:[{...row,id:'opencode#local',stale:true}]}));
  expect(html).toContain('Local model · Skipped');
  expect(html).not.toContain('opencode#local');
});

test('planner card reports only known connection facts', () => {
  const html = visible(draw(<AgentsIntro tab="executors"/>));
  expect(html).toContain('Plans and reviews');
  const connected = {...snapshot,console:{pid:1,handle:null,paneKey:null,startedAt:snapshot.at-60,heartbeatAt:snapshot.at-10}};
  expect(visible(draw(<AgentsIntro tab="executors"/>,connected))).toContain('Connected');
  expect(visible(draw(<AgentsIntro tab="executors"/>,connected))).toContain('connection seen 10s ago');
  expect(visible(draw(<AgentsIntro tab="executors"/>,{...connected,console:{...connected.console,heartbeatAt:snapshot.at-600}}))).not.toContain('Connected');
  expect(html).not.toContain('hooks and status line');
  expect(html).not.toContain('keeps 10%');
  expect(visible(draw(<AgentsIntro tab="executors"/>,{...snapshot,console:null}))).not.toContain('Connected');
});

test('fractional usage and task-cost captions use whole percentages', () => {
  expect(costCopy({account:'codex',deltaPct:1.75,window:'week'})).toBe('Codex · used 2% of weekly quota');
  expect(reasonCopy('ahead, used 81.75% / pace 70.577%')).not.toMatch(/\d+\.\d+%/);
});

test('Dispatcher shows one friendly executor identity without raw ids', () => {
  const view = {strategy:'default',planner:'codex',plannerAccount:'codex',source:'built-in' as const,config:dispatchConfigSchema.parse({})};
  const render = (id: string) => draw(<SetupEditor view={view} eligibility={{kind:'global',rules:[{executors:[id]}],available:[id]}} onSaved={()=>{}} onDirtyChange={()=>{}}/>);
  const plain = render('codex');
  expect(plain).toContain('Codex');
  expect(plain).not.toContain('class="pc-executor-id"');
  const named = render('claude-code#claude1');
  expect(named).toContain('Claude Code · claude1');
  expect(named).not.toContain('class="pc-executor-id"');
  expect(named).not.toMatch(/(?:title|aria-label)="[^"]*claude-code#claude1/);
  expect(visible(named)).not.toContain('claude-code#claude1');
});

 test('stale account copy gives one readable age or a refresh instruction', () => {
  expect(usageView(usageStateFor({ usedPct: 28, stale: true, capturedAt: snap.at - 113 * 3600 }, snap.at), snap.at).freshness).toBe('Reading 113h old · refresh');
  expect(usageView(usageStateFor({ usedPct: 28, stale: true, capturedAt: null }, snap.at), snap.at).freshness).toBe('Reading of unknown age · refresh');
 });

 test('Dispatcher rows use board readiness and a short reason', () => {
  const view = {strategy:'default',planner:'codex',plannerAccount:'codex',source:'built-in' as const,config:dispatchConfigSchema.parse({})};
  const html = visible(draw(<SetupEditor view={view} eligibility={{kind:'global',rules:[{executors:[row.id]}],available:[row.id]}} onSaved={()=>{}} onDirtyChange={()=>{}}/>,{...snap,executors:[{...row,eligibility:{...eligible,state:'uncertain',reasons:[]}}]}));
  expect(html).toContain('Skipped');
  expect(draw(<SetupEditor view={view} eligibility={{kind:'global',rules:[{executors:[row.id]}],available:[row.id]}} onSaved={()=>{}} onDirtyChange={()=>{}}/>,{...snap,executors:[{...row,eligibility:{...eligible,state:'uncertain',reasons:[]}}]})).toContain('Refresh to confirm availability');
  expect(html).not.toMatch(/Uncertain fallback|Unavailable|Verification is not available/);
 });

test.skipIf(!process.env.PACER_TEST_BROWSER)('Dispatcher technical detail opens on focus and Escape stays in Settings', async () => {
  const { chromium } = await import('playwright-core');
  const build = await Bun.build({entrypoints:['test/fixtures/ui/settings-copy-browser.tsx'],target:'browser',format:'iife'});
  if (!build.success) throw new AggregateError(build.logs);
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:await build.outputs[0]!.text()});
    await page.evaluate(() => { (window as any).escaped=false; window.addEventListener('keydown',event=>{if(event.key==='Escape')(window as any).escaped=true;}); });
    const reason = page.locator('.pc-tooltip [tabindex="0"]').first();
    await reason.focus();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor({state:'visible'});
    expect(await tooltip.innerText()).toContain('Executor availability is not confirmed');
    await page.keyboard.press('Escape');
    expect(await tooltip.isVisible()).toBe(false);
    expect(await reason.evaluate(node=>document.activeElement===node)).toBe(true);
    expect(await page.evaluate(()=>(window as any).escaped)).toBe(false);
  } finally { await browser.close(); }
});

test('Accounts quota copy suppresses synthetic reactive and unmetered readings', () => {
  for (const [action, source, label] of [['unsupported', 'reactive', 'No usage figure'], ['unmetered', 'unmetered', 'Unmetered']] as const) {
    const account = {name:'synthetic',kind:'endpoint',signedIn:true,usageCheck:{action,consentRequired:false,description:'Provider explanation'},usageState:usageStateFor({usedPct:null,verdict:source==='unmetered'?'UNMETERED':'OK',source},snapshot.at)};
    const html = draw(<AccountsSection initialData={[account]} initialConfig={{keys:{},planners:[]} as any}/>, {...snapshot,accounts:[{...snapshot.accounts![0]!,name:account.name,source,usedPct:0,capturedAt:snapshot.at,stale:true}]});
    expect(visible(html)).toContain(label);
    expect(html).not.toContain('role="meter"');
    expect(visible(html)).not.toMatch(/0%|Last observed|No observation|No usage reported|Usage observed|Historical usage|Stale|check account usage/);
    expect(html).not.toContain('Check usage<span');
  }
});
