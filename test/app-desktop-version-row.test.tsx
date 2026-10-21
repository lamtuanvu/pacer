import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { DesktopVersionRow } from '../app/src/screens/settings/Updates';

test('desktop row exposes its independent version and a working release destination', () => {
 const html = renderToString(<DesktopVersionRow version="0.3.1" loading={false} report={{current:'0.5.0',latest:'0.5.0',available:false}}/>);
 expect(html).toContain('Desktop app 0.3.1 · Update available: 0.5.0');
 expect(html).toContain('https://github.com/lamtuanvu/pacer/releases/tag/v0.5.0');
 expect(html).toContain('replace the installed app');
 expect(html).not.toContain('Up to date');
});
test('unknown desktop versions offer replacement guidance while loading does not', () => {
 const unknown = renderToString(<DesktopVersionRow version={null} loading={false}/>);
 expect(unknown).toContain('Version unavailable');
 expect(unknown).toContain('/releases/latest');
 const loading = renderToString(<DesktopVersionRow version={null} loading={true}/>);
 expect(loading).toContain('Reading version');
 expect(loading).not.toContain('Download desktop app');
});
