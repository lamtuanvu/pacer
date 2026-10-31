import {expect, test} from 'bun:test';
import {renderToString} from 'preact-render-to-string';
import {readTokens} from '../app/tokens-gen';
import {settingsText, displayPath, diagnosticDetail} from '../app/src/screens/settings/presentation';
import {DiagnosticResults} from '../app/src/screens/settings/Diagnostics';
import {AppFrame} from '../app/src/shell/AppFrame';
import {TopBar} from '../app/src/shell/TopBar';
import {StatusBar} from '../app/src/shell/StatusBar';
import {Rail} from '../app/src/shell/Rail';
import {createKeyRegistry} from '../app/src/keys/registry';
import {initialState} from '../app/src/data/store';
import {TaskContext} from '../app/src/screens/task-shared';
import {resolveRoute, type Route} from '../app/src/router';
import snapshot from './fixtures/ui/snapshot.json';

const draw=(children:any)=>renderToString(<TaskContext.Provider value={{state:{...initialState(),snapshot} as any,api:{} as any}}>{children}</TaskContext.Provider>);
test('all consumed radii and type styles follow the canvas scale',()=>{
 const tokens=readTokens('app/src/ds');
 expect(tokens.radius.tokens.filter(t=>!['4px','6px','8px','12px','99px'].includes(t.value))).toEqual([]);
 expect(tokens.type.groups.flatMap(g=>g.styles).filter(t=>!['11px','12px','13px','14px','16px','22px','28px'].includes(t.fontSize))).toEqual([]);
 expect(tokens.type.groups.flatMap(g=>g.styles).find(t=>t.name==='count-badge')?.fontSize).toBe('11px');
});
test('shell links reach Budget and Tasks, and session has only its body title',()=>{
 const html=draw(<><TopBar brand="Pacer" title="Session" heading={{title:'Live title',agent:'codex'}} planner={snapshot.planner as any} mode="normal" connected lastUpdate={1} onDelegate={()=>{}}/><StatusBar snapshot={snapshot as any} registry={createKeyRegistry({controlActive:()=>false})}/><h1>Live title</h1></>);
 expect(html).toMatch(/href="#\/settings\/planner"[^>]*class="pc-planner/);
 expect(html).toMatch(/href="#\/tasks"[^>]*class="pc-statusbar__work/);
 expect(html.match(/<h1/g)).toHaveLength(1);
 expect(html).not.toContain('pc-topbar__heading');
});
test('dock belongs between the centre column boundaries; rail keeps only attention counts',()=>{
 const html=draw(<AppFrame activity={<nav>Activity</nav>} left={<aside>Scope</aside>} right={<aside>Inspector</aside>} main="Work" dock={<section id="dock">Terminal</section>}/>);
 expect(html).toMatch(/pc-work-wrap[\s\S]*pc-work[\s\S]*id="dock"[\s\S]*Inspector/);
 const rail=draw(<Rail route={resolveRoute('#/') as Route} counts={snapshot.counts} terminal={{open:true,toggle:()=>{}}}/>);
 expect(rail).toContain('aria-label="Workspace"');
 expect(rail).not.toContain('pc-rail__badge--info');
 expect(rail).not.toContain('aria-label="Dispatcher"');
});
test('diagnostics render plain labels without raw identities, paths, commands or key dumps',()=>{
 // Path presentation is lexical; a real TMPDIR may itself be inside a user's home.
 const suffix='accounts/team/skills/pacer/SKILL.md';
 for(const home of ['/Users/example/', '/home/example/', '/fixture/home/']) {
  expect(displayPath(home+suffix)).toBe('~/'+suffix);
 }
 expect(displayPath('~/'+suffix)).toBe('~/'+suffix);
 expect(settingsText('Integration freshness codex#personal')).toBe('Integration freshness Codex · personal');
 expect(settingsText('opencode#local')).toBe('OpenCode · local');
 const checks=[{name:'Integration freshness codex#personal',level:'fail',detail:'installed: true; healthy: false',fix:'pacer uninstall codex#personal'},{name:'CLI codex#personal',level:'fail',detail:'codex --help failed: fixture'},{name:'Service latency',level:'ok',detail:'/v2/snapshot max 1.7 ms'}] as any;
 const html=renderToString(<DiagnosticResults report={{checkedAt:1,checks}}/>);
 expect(html).toContain('Codex · personal');
 expect(html).not.toMatch(/codex#|--help|pacer uninstall|\/v2|installed: true/);
 expect(html.match(/<details/g)).toHaveLength(3);
 expect(html).not.toMatch(/<details[^>]*open/);
 expect(diagnosticDetail(checks[0])).not.toContain('true');
});

test('an acknowledged review cannot reappear from a delayed snapshot, while a newer request remains visible',async()=>{
 const {withoutReviewedAttention}=await import('../app/src/data/store');
 const original={...snapshot.attention[0]!,id:'review:task',taskId:'task',kind:'review',since:1};
 const newer={...original,since:2};
 const projected=withoutReviewedAttention({...snapshot,attention:[original,newer]} as any,new Set(['review:task:1']));
 expect(projected.attention?.map(item=>({id:item.id,since:item.since}))).toEqual([{id:newer.id,since:2}]);
});

test('Settings messages present commands and raw operational results in plain language',async()=>{
 const {performOperation}=await import('../app/src/screens/settings/shared');
 const result=await performOperation(async()=>({message:'codex --help failed: fixture',hint:'pacer uninstall codex#personal',warning:'installed: true; healthy: false'}) as any,'agent.connect',{});
 for(const text of [result.message,result.hint,result.warning]) expect(text).not.toMatch(/codex#|--help|pacer uninstall|installed: true/);
 expect(result.message).toContain('Diagnostics');
 expect(result.hint).toContain('Budget & pacing');
});

test('a plugin without its own settings nav page keeps Plugins current',async()=>{
 const {SettingsPanel}=await import('../app/src/shell/SettingsPanel');
 const html=draw(<SettingsPanel route={resolveRoute('#/settings/plugins/no-page') as Route} counts={null}/>);
 expect(html).toMatch(/href="#\/settings\/plugins"[^>]*aria-current="page"/);
});
