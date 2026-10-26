import { h, render } from "preact";
import { TerminalView } from "../../app/src/term/term";

render(<TerminalView id="search-fixture" shell url="ws://127.0.0.1/fixture" control live />, document.getElementById("root")!);
