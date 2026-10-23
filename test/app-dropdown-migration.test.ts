import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function screenFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? screenFiles(join(path, entry.name))
    : entry.name.endsWith('.tsx') ? [join(path, entry.name)] : []));
  return nested.flat();
}

test('app screens use the shared choice picker rather than native selects', async () => {
  const files = await screenFiles('app/src/screens');
  const native = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (/<(?:Select|select)\b/.test(source)) native.push(file);
  }
  expect(native).toEqual([]);
});
