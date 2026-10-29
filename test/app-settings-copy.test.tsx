import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { SettingsGeneral } from '../app/src/screens/settings/General';
import { SetupEditor } from '../app/src/screens/settings/DispatcherSetup';
import { dispatchConfigSchema } from '../src/dispatch/types';
import { costCopy, reasonCopy } from '../src/view-model/copy';
import { AgentsIntro, ExecutorsSection } from '../app/src/screens/settings/Executors';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { accountLabel } from '../src/view-model/words';
import { accountUsageFreshness, executorReadiness, executorWeekUsage } from '../src/view-model/capacity';
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
  expect(executorWeekUsage({...row,usedPct:81.45},snap)).toBe('81% of week');
  expect(executorWeekUsage({...row,stale:true},snap)).toBe('Stale · refresh to use');
  expect(executorWeekUsage(row,{...snap,accounts:[{...snap.accounts![0]!,verdict:'UNMETERED'}]})).toBe('Unmetered');
  const reset = new Date('2026-11-01T12:00:00Z').getTime()/1000;
  expect(executorWeekUsage({...row,usedPct:81},{...snap,accounts:[{...snap.accounts![0]!,resetsAt:reset}]})).toBe('81% of week · resets Sun');
  const html = draw(<ExecutorsSection/>,snap);
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
  const account = {...snap.accounts![0]!,stale:true,usedPct:28,capturedAt:snap.at-113*3600,eligibility:eligible};
  expect(accountUsageFreshness({...account,eligibility:{...eligible,evaluatedAt:snap.at}})).toBe('Reading 113h old');
  expect(accountUsageFreshness({...account,capturedAt:null})).toBe('Stale reading · refresh to use');
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
