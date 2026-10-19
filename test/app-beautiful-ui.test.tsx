import { expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import { Button, ButtonLink } from '../app/src/ds/Button';
import { Field, TextInput, Checkbox, Switch, Range } from '../app/src/ds/Controls';
import { DensityProvider } from '../app/src/ds/Density';
import { ListRow, TextRow, SegmentedControl, ApprovalCard, LoadingState, EmptyState } from '../app/src/ds/Patterns';

test('busy button is disabled and forwards form attributes without losing its name', () => {
 const html=render(<Button busy name="approve" form="review" aria-describedby="reason">Accept</Button>);
 expect(html).toContain('type="button"');expect(html).toContain('disabled');expect(html).toContain('aria-busy="true"');expect(html).toContain('form="review"');expect(html).toContain('aria-describedby="reason"');expect(html).toContain('Accept');
});
test('button links preserve native navigation attributes',()=>{
 const html=render(<ButtonLink href="#/review" target="_blank" rel="noopener" aria-current="page">Review</ButtonLink>);
 expect(html).toStartWith('<a ');expect(html).toContain('href="#/review"');expect(html).toContain('target="_blank"');expect(html).toContain('aria-current="page"');expect(html).not.toContain('type="button"');
});
test('fields connect label, help and error with native validation',()=>{
 const html=render(<Field label="Repository" help="Absolute directory" error="Required"><TextInput id="repo" required name="repo" /></Field>);
 expect(html).toContain('for="repo"');expect(html).toContain('id="repo-help"');expect(html).toContain('id="repo-error"');expect(html).toContain('aria-describedby="repo-help repo-error"');expect(html).toContain('aria-invalid="true"');expect(html).toContain('required');
});
test('checkbox switch and range retain native semantics and labels',()=>{
 const html=render(<><Checkbox label="Select task" checked disabled /><Switch label="Full live sessions" checked /><Range label="Reserve" id="reserve" min={0} max={100} step={5} value={25} /></>);
 expect(html).toContain('type="checkbox"');expect(html).toContain('Select task');expect(html).toContain('role="switch"');expect(html).toContain('type="range"');expect(html).toContain('for="reserve"');expect(html).toContain('step="5"');expect(html).toContain('value="25"');
});
test('selected filters are labelled groups with pressed buttons',()=>{
 const html=render(<SegmentedControl label="Sessions" value="running" options={[{value:'all',label:'All'},{value:'running',label:'Running'}]} onChange={()=>{}} />);
 expect(html).toContain('role="group"');expect(html).toContain('aria-label="Sessions"');expect(html).toContain('aria-pressed="true"');expect(html).toContain('type="button"');
});
test('rows keep content separate from secondary controls and respect compact density',()=>{
 const html=render(<DensityProvider value="compact"><ListRow leading="◐" content={<ButtonLink href="#/task">Long task title</ButtonLink>} meta="2m" actions={<Button>Review</Button>} /><TextRow label="Executor" value="Codex" meta="Local" /></DensityProvider>);
 expect(html).toContain('pc-list-row--compact');expect(html).toContain('pc-list-row__actions');expect(html).not.toMatch(/<a[^>]*>[^]*<button[^]*<\/a>/);expect(html).toContain('pc-text-row__meta');
});
test('approval framing and asynchronous states announce meaningful content',()=>{
 const html=render(<><ApprovalCard title="Review changes" actions={<Button>Accept</Button>}>Evidence</ApprovalCard><LoadingState label="Loading sessions…" /><EmptyState title="No sessions" description="New tasks appear here." /></>);
 expect(html).toContain('Review changes');expect(html).toContain('Evidence');expect(html).toContain('role="status"');expect(html).toContain('Loading sessions…');expect(html).toContain('No sessions');
});

test('compound fields label the nested control and retain siblings and feedback',()=>{
 const html=render(<Field label="Reserve" help="Kept for review"><div className="layout"><Range id="reserve-nested" min={0} max={50}/><output>25%</output></div><p>Service feedback</p></Field>);
 expect(html).toContain('for="reserve-nested"');expect(html).toContain('aria-describedby="reserve-nested-help"');expect(html).toContain('<output>25%</output>');expect(html).toContain('<p>Service feedback</p>');expect(html).not.toContain('class="layout" id=');
});
test('range forwards caller styling and accessible attributes to native input',()=>{
 const html=render(<Range id="r" className="reserve-width" aria-label="Reserve" aria-valuetext="25 percent" name="reserve"/>);
 expect(html).toMatch(/class="(?=[^"]*pc-range)(?=[^"]*reserve-width)[^"]*"/);expect(html).toContain('aria-valuetext="25 percent"');expect(html).toContain('name="reserve"');
});

test('mixed checkbox exposes partial selection without pretending all are checked',()=>{
 const html=render(<Checkbox label="Select all" mixed checked={false}/>);
 expect(html).toContain('aria-checked="mixed"');expect(html).not.toContain(' checked');
});
