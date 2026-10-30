import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { IconButton } from '../app/src/ds/Button';
import { ChoiceCard, Tabs } from '../app/src/ds/Patterns';
import { SortableList } from '../app/src/ds/SortableList';
import { SettingRow } from '../app/src/ds/SettingRow';
import { TextInput } from '../app/src/ds/Controls';
import { pluginIcon } from '../app/src/screens/settings/plugin-presentation';

test('board variants are explicit and preserve accessible control semantics', () => {
  const html=renderToString(<>
    <IconButton geometry="board" icon="more" aria-label="More actions for an agent"/>
    <Tabs variant="pills" label="Task type" id="types" value="tests" options={[{value:'tests',label:'Tests'}]} onChange={()=>{}}/>
    <ChoiceCard layout="agent" selected>Codex</ChoiceCard>
    <SettingRow layout="inline-help" label="Parallel tasks"><TextInput type="number"/><span>Up to 16</span></SettingRow>
  </>);
  expect(html).toContain('pc-icon-button--board');
  expect(html).toContain('aria-label="More actions for an agent"');
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-controls="types-tests-panel"');
  expect(html).toContain('pc-segmented--pills');
  expect(html).toContain('pc-setting-row--inline-help');
  expect(html).toContain('aria-pressed="true"');
});

test('executor list keeps keyboard actions and exposes an end-of-list drag guide', () => {
  const html=renderToString(<SortableList layout="executor" iconControls label="Executors" items={[{key:'one',label:'One'},{key:'two',label:'Two'}]} onReorder={()=>{}} onRemove={()=>{}}/>);
  expect(html).toContain('pc-sortable__drop-guide');
  expect(html).toContain('Move up and Move down buttons with the keyboard');
  for (const label of ['Move down: One','Move up: Two','Remove: One']) expect(html).toContain(`aria-label="${label}"`);
  expect(html).not.toContain('>↑<');
  expect(html).not.toContain('>↓<');
  expect(html).not.toContain('>×<');
  expect(html.match(/data-sortable-key=/g)).toHaveLength(2);
});

test('bundled plugin icons describe the capability even without contributed UI surfaces', () => {
  expect(pluginIcon('pacer-agent-session',[])).toBe('plugin-terminal');
  expect(pluginIcon('pacer-assistant',[])).toBe('spark');
  expect(pluginIcon('unknown',[])).toBe('plugin');
});

import { chromium } from 'playwright-core';
import { DensityContext } from '../app/src/ds/Density';
import { Stepper } from '../app/src/ds/Stepper';
import { ActionMenu } from '../app/src/ds/ActionMenu';

test.skipIf(!process.env.PACER_TEST_BROWSER)('board geometry survives both themes and all desktop densities', async () => {
  const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {
    const css=(await Promise.all(['tokens.css','components.css','feedback.css','action-menu.css'].map(file=>Bun.file(`app/src/ds/${file}`).text()))).join('\n')+'\n'+await Bun.file('app/src/screens/settings/settings.css').text();
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    for (const theme of ['dark','light']) for (const density of ['normal','compact','settings'] as const) {
      const html=renderToString(<DensityContext.Provider value={density}><div className="pc-settings-board">
        <IconButton geometry="board" icon="more" aria-label="Agent actions"/>
        <ActionMenu label="Plugin actions" items={[{label:'Run checks',onSelect:()=>{}}]}/>
        <ChoiceCard layout="agent"><strong>Agent name</strong><span>A description long enough to require more than one line</span></ChoiceCard>
        <Stepper label="Wizard" steps={[{id:'agent',title:'Agent',detail:'Choose who will do the work',state:'current',reachable:true}]} onSelect={()=>{}}/>
        <Tabs variant="pills" label="Task type" value="tests" options={[{value:'tests',label:'Tests'}]} onChange={()=>{}}/>
        <SettingRow layout="inline-help" label="Parallel tasks"><TextInput type="number" value="1"/><span className="pc-control-help">Up to 16</span></SettingRow>
      </div></DensityContext.Provider>);
      await page.setContent(`<html data-theme="${theme}" data-density="${density}"><style>${css}</style>${html}</html>`);
      const geometry=await page.evaluate(()=>{
        const read=(sel:string)=>{const e=document.querySelector(sel)!,r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.width,r.height,s.padding,s.borderRadius,s.fontSize,s.lineHeight];};
        return {icon:read('.pc-icon-button'),menu:read('.pc-action-menu__trigger'),glyph:read('.pc-action-menu__trigger svg'),choice:read('.pc-choice-card--agent'),step:read('.pc-stepper__step'),tab:read('[role=tab]'),number:read('.pc-setting-row--inline-help input')};
      });
      expect(geometry.icon.slice(0,4)).toEqual([28,28,'0px','6px']);
      expect(geometry.menu.slice(0,4)).toEqual([28,28,'0px','6px']);
      expect(geometry.glyph.slice(0,2)).toEqual([16,16]);
      expect(geometry.choice.slice(2)).toEqual(['14px','12px','13px','19px']);
      expect(geometry.step.slice(2)).toEqual(['10px','8px','13px','19px']);
      expect(geometry.tab[1]).toBe(28);
      expect(geometry.number.slice(0,4)).toEqual([72,32,'0px 10px','6px']);
    }
  } finally {await browser.close();}
},20000);
