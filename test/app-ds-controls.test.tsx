import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'preact-render-to-string';
import { HostSessionSwitch } from '../app/src/screens/settings/HostSessionSwitch';

test('app links and native controls always opt into their styles', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
  const violations: string[] = [];
  for (const path of ['screens', 'shell', 'tray'].flatMap(dir => files(`app/src/${dir}`))) {
    const source = readFileSync(path, 'utf8');
    for (const [, tag, attrs] of source.matchAll(/<(a|select|details|input)\b([^>]*?)>/g)) {
      const cls = /className=("[^"]*"|'[^']*'|\{`[^`]*`\})/.exec(attrs!)?.[1] ?? '';
      const required = tag === 'select' ? 'pc-select' : tag === 'details' ? 'pc-disclosure' : tag === 'input' && attrs!.includes('type="checkbox"') ? 'pc-checkbox__input' : undefined;
      if (required && !cls.includes(required)) violations.push(`${path}: ${tag} needs ${required}`);
      if (tag === 'a' && !cls) violations.push(`${path}: unstyled link`);
    }
  }
  expect(violations).toEqual([]);
});

test('host checkbox preserves switch semantics, inline label and disabled state', () => {
  const html = renderToString(<HostSessionSwitch alias="devbox" host={{session:'full'}} disabled run={() => {}}/>);
  expect(html).toContain('<label class="pc-checkbox">');
  expect(html).toMatch(/class="[^"]*pc-checkbox__input[^"]*"/);
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-label="Full live sessions"');
  expect(html).toContain('checked');
  expect(html).toContain('disabled');
  expect(renderToString(<HostSessionSwitch alias="legacy" host={{}} run={() => {}}/>)).toBe('');
});

test('new control styles only reference generated design tokens', () => {
  const css = readFileSync('app/src/ds/components.css', 'utf8').split('/* Text actions')[1]!;
  const tokens = readFileSync('app/src/ds/tokens.css', 'utf8');
  for (const [, token] of css.matchAll(/var\((--[^)]+)\)/g)) { if (['--agent-size','--mark-size','--pc-panel-width'].includes(token!)) continue; if (['--frame-top','--frame-status'].includes(token!)) { const shell = readFileSync('app/src/styles.css', 'utf8'); expect(shell).toContain(`${token}:var(--size-`); continue; } expect(tokens).toContain(`${token}:`); }
});

test('section typography is shared and component sizes come from tokens', async () => {
  const { SectionHeading } = await import('../app/src/ds/SectionHeading');
  expect(renderToString(<SectionHeading id="running">Running</SectionHeading>)).toBe('<h2 id="running" class="pc-section-heading">Running</h2>');
  expect(renderToString(<SectionHeading as="label" htmlFor="retry">Or retry on</SectionHeading>)).toBe('<label for="retry" class="pc-section-heading">Or retry on</label>');
  for (const path of ['app/src/styles.css', 'app/src/ds/components.css', 'app/src/screens/settings/settings.css', 'app/src/screens/session/session.css']) {
    expect(readFileSync(path, 'utf8')).not.toMatch(/font-size:\s*[\d.]+px/);
  }
  const css = readFileSync('app/src/ds/components.css', 'utf8');
  expect(css).toMatch(/\.pc-inline-link\s*\{[^}]*text-decoration:\s*underline/);
  expect(css).toContain('.pc-inline-link:focus-visible');
});
