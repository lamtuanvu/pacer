import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { ServiceBuildGuidance } from '../app/src/screens/settings/ServiceBuildGuidance';
import { initialState, reduceStore } from '../app/src/data/store';

const hello = (diagnostic: unknown) => ({ protocol: '3.0.0', pacer: '1.0.0', ops: [], events: [], desktopBuildDiagnostic: diagnostic });
test('desktop build claims are bounded, unverified and have no mutation action', () => {
  for (const [status, copy] of [['unverified', 'core descriptor claims match'], ['mismatch', 'core descriptor claims differ'], ['unknown', 'could not compare']] as const) {
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
});
