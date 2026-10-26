import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TerminalView } from '../../../app/src/term/term';

// An in-page session socket: answers hello with a snapshot and records size frames.
const sizes: string[] = [];
class FakeSocket {
  readyState = 0; binaryType = 'blob';
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  private emit(frame: object) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0); }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') return;
    const frame = JSON.parse(data);
    if (frame.type === 'hello') this.emit({ type: 'snapshot', outputOffset: 0, cols: 80, rows: 24, scrollbackAnsi: '', screenAnsi: 'ready', controller: null, viewers: 1 });
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
      <TerminalView id="t-1" url="ws://fixture.invalid/session" control conversation footer={footer} />
    </div>
    <footer ref={setFooter} id="footer" role="group" aria-label="Session control" />
  </article>;
}
render(<><Conversation /><section id="supervised"><TerminalView id="t-2" url="ws://fixture.invalid/session" control /></section></>, document.getElementById('app')!);
(window as unknown as { conversationFixture: object }).conversationFixture = { sizes: () => [...sizes], hide: (value: boolean) => setHidden(value) };
