import { startClientControl } from "../data/control";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createStore } from "../data/store";
import { createApi } from "../data/api";
import { createTrayIpc } from "./ipc";
import { Tray } from "./Tray";
import { followSavedTheme } from "../theme";

followSavedTheme();

const store = createStore(), ipc = createTrayIpc();
function TrayApp() {
  const [state, setState] = useState(store.getState);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [api] = useState(() => createApi(() => setSessionEnded(true)));
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const stop = store.start();
    const stopControl = startClientControl(api, 'tray', async () => false);
    return () => { stopControl(); unsubscribe(); stop(); };
  }, []);
  return <Tray snapshot={state.snapshot} activity={state.activity} connected={state.connected} sessionEnded={state.sessionEnded || sessionEnded} api={api} ipc={ipc} />;
}
render(<TrayApp />, document.getElementById("app")!);
