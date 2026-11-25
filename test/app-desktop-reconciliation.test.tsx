import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { ServiceBuildGuidance } from '../app/src/screens/settings/ServiceBuildGuidance';
import { initialState, reduceStore } from '../app/src/data/store';

const hello = (diagnostic: unknown) => ({ protocol: '3.0.0', pacer: '1.0.0', ops: [], events: [], desktopBuildDiagnostic: diagnostic });
test('different, legacy and unknown build claims are bounded and have no mutation action', () => {
  for (const [status, copy] of [['mismatch', 'core descriptor claims differ'], ['unknown', 'could not compare'], ['legacy', 'predates this build check']] as const) {
    const html = renderToString(<ServiceBuildGuidance diagnostic={status} connected />);
    expect(html).toContain(copy);
    expect(html).toContain('not verified');
    expect(html).toContain('Service reconciliation is unavailable');
    expect(html).toContain('terminal sessions');
    expect(html).toContain('installation documentation');
    expect(html).not.toContain('pacer update');
    expect(html).not.toContain('brew upgrade');
    expect(html).not.toContain('npm install');
    expect(html).not.toContain('<button');
  }
});
test('a matching build check while connected adds no descriptor or ownership warning', () => {
  expect(renderToString(<ServiceBuildGuidance diagnostic="unverified" connected />)).toBe('');
  // A stale/unconnected reading still needs the reconnect notice, not a clean bill of health.
  const stale = renderToString(<ServiceBuildGuidance diagnostic="unverified" connected={false}/>);
  expect(stale).toContain('Reconnecting');
  expect(stale).toContain('Service reconciliation is unavailable');
});
test('missing, hostile and stale diagnostics fail closed and reconnect replaces them', () => {
  let state = reduceStore(initialState(), {type:'hello', hello:hello({status:'mismatch', proof:'unverified'})});
  expect(state.desktopBuildDiagnostic).toBe('mismatch');
  state = reduceStore(state, {type:'disconnected'});
  expect(renderToString(<ServiceBuildGuidance diagnostic={state.desktopBuildDiagnostic} connected={false}/>)).toContain('Reconnecting');
  for (const value of [undefined, {status:'verified', proof:'verified'}, {status:'<img src=x>', proof:'unverified'}]) {
    state = reduceStore(state, {type:'hello', hello:hello(value)});
    expect(state.desktopBuildDiagnostic).toBe('unknown');
  }
  state = reduceStore(state, {type:'hello', hello:hello({status:'unverified', proof:'unverified'})});
  expect(state.desktopBuildDiagnostic).toBe('unverified');
  state = reduceStore(state, {type:'hello', hello:hello({status:'legacy', proof:'unverified'})});
  expect(state.desktopBuildDiagnostic).toBe('legacy');
});
test('a legacy service names its version but keeps the same finish-work and ownership warnings', () => {
  // 0.14.0 already sends coreBuild (#637); use a version from before that to stay honest.
  const html = renderToString(<ServiceBuildGuidance diagnostic="legacy" connected serviceVersion="0.13.0"/>);
  expect(html).toContain('0.13.0');
  expect(html).toContain('predates this build check');
  // A legacy service is still an old updater of unknown ownership: the old
  // Settings -> Updates button can restart live work, so this must not read
  // as safe to update "normally" or drop the finish-work/ownership guidance.
  expect(html).not.toContain('normally');
  expect(html).toContain('Service reconciliation is unavailable');
  expect(html).toContain('terminal sessions');
  expect(html).toContain('installation documentation');
  expect(html).not.toContain('<button');
  expect(renderToString(<ServiceBuildGuidance diagnostic="legacy" connected serviceVersion={null}/>)).not.toContain('()');
});
