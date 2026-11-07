import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TerminalView } from '../../../app/src/term/term';
import { keys } from '../../../app/src/keys/instance';
import { attachKeyRegistry } from '../../../app/src/keys/registry';

// An in-page session host: answers hello with a snapshot and its control frame, as a real host does, and records
// size, focus and input frames. window.sessionVersions picks the host range; [1,2] has no controller.
const sizes: string[] = [], sent: string[] = [];
const versions: [number, number] = (window as unknown as { sessionVersions?: [number, number] }).sessionVersions ?? [1, 1];
const shared = versions[1] >= 2;
class FakeSocket {
  readyState = 0; binaryType = 'blob';
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private name: string;
  constructor(url: string) { this.name = new URL(url).pathname.slice(1); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  private emit(frame: object) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0); }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') { sent.push(`${this.name}:input`); return; }
    const frame = JSON.parse(data);
    sent.push(`${this.name}:${frame.type}`);
    if (frame.type === 'hello') {
      this.emit({ type: 'snapshot', outputOffset: 0, cols: 80, rows: 24, scrollbackAnsi: '', screenAnsi: 'ready', controller: null, viewers: 1 });
      this.emit({ type: 'control', controller: null, you: shared, versions, pacer: shared ? '0.14.0' : '0.13.0' });
    }
    if (frame.type === 'take') this.emit({ type: 'control', controller: 'app', you: true });
    if (frame.type === 'release') this.emit({ type: 'control', controller: null, you: false });
    if (frame.type === 'size') { sizes.push(`${frame.cols}x${frame.rows}`); this.emit({ type: 'resize', cols: frame.cols, rows: frame.rows }); }
  }
  close() { this.readyState = 3; }
}
(window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

let setHidden: (hidden: boolean) => void = () => {};
function Conversation() {
  const [footer, setFooter] = useState<HTMLElement | null>(null), [hidden, hide] = useState(false);
  setHidden = hide;
  return <article>
    <div id="session-panel" hidden={hidden}>
      <TerminalView id="t-1" url="ws://fixture.invalid/conversation" control conversation footer={footer} />
    </div>
    <footer ref={setFooter} id="footer" role="group" aria-label="Session control" />
  </article>;
}
// The app's real shortcut registry with one global binding, so tests see whether a key reaches the app.
const shortcuts: string[] = [];
attachKeyRegistry(keys, window);
keys.register({ keys: 'Mod-k', label: 'Command menu', scope: 'global', run: () => shortcuts.push('Mod-k') });
// window.handBack (when set) renders a 1.2 takeover session whose Hand back calls it.
const handBack = (window as unknown as { handBack?: () => Promise<unknown> }).handBack;
render(<><Conversation /><section id="supervised"><TerminalView id="t-2" url="ws://fixture.invalid/supervised" control active="cli:ghostty" agent="codex" /></section>
  {handBack && <section id="takeover"><TerminalView id="t-3" url="ws://fixture.invalid/takeover" control driving agent="codex" autoControl={false} onHandBack={handBack} /></section>}</>, document.getElementById('app')!);
(window as unknown as { conversationFixture: object }).conversationFixture = { sizes: () => [...sizes], sent: () => [...sent], shortcuts: () => [...shortcuts], hide: (value: boolean) => setHidden(value) };
