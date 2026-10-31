import { afterEach, expect, test } from 'bun:test';
import { applyDensity, savedDensity } from '../app/src/density';
const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
test('density defaults comfortable, validates persisted choices, and applies a root attribute', () => {
  let value: string | null = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => value } });
  const root = { dataset: {} } as HTMLElement;
  expect(savedDensity()).toBe('normal');
  value = 'compact'; applyDensity(savedDensity(), root);
  expect(root.dataset.density).toBe('compact');
  value = 'normal'; applyDensity(savedDensity(), root);
  expect(root.dataset.density).toBe('normal');
  value = 'invalid'; expect(savedDensity()).toBe('normal');
});
test('unavailable device storage defaults comfortable', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('denied'); } });
  expect(savedDensity()).toBe('normal');
});
