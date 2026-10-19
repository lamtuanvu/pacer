import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('app source never uses native browser dialogs (unavailable in desktop webviews)', () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
  }
  const violations = files('app/src').filter(path => /window\s*\.\s*(confirm|prompt|alert)\b/.test(readFileSync(path, 'utf8')));
  expect(violations).toEqual([]);
});
