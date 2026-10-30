import { AuroraLauncher } from "../../../app/src/ds/AuroraSheet";
import { Rail } from "../../../app/src/shell/Rail";
import { resolveRoute, type Route } from "../../../app/src/router";

/**
 * The shell frame the notice stack floats over, as AppFrame and AssistantHost build it: the top bar, the work area with
 * the assistant layer and its launcher, then the status bar in the wide layout or the real bottom navigation in the
 * narrow one. `?launcher=open` shows the launcher in its open-sheet position and `?launcher=none` hides it.
 */
export function NoticeFrame({ narrow }: { narrow: boolean }) {
  const launcher = new URLSearchParams(location.search).get("launcher") ?? "closed", open = launcher === "open";
  const layer = launcher !== "none" && !(narrow && open) && <div className={narrow ? "pc-aurora-layer pc-aurora-layer--narrow" : "pc-aurora-layer"}><div className="pc-assistant-positioner">
    <AuroraLauncher open={open} onClick={() => {}} className={open ? "pc-aurora-launcher--open" : undefined} shortcut={narrow ? undefined : "⌘J"} />
  </div></div>;
  return <div className={`pc-app${narrow ? " pc-app--narrow" : " pc-app--with-status"}`}>
    {!narrow && <header className="pc-topbar" />}
    {narrow && <Rail route={resolveRoute("#/") as Route} counts={null} narrow />}
    <div className="pc-body"><div className="pc-work-wrap">
      <div className="pc-work"><main id="main-content" tabIndex={-1}><button id="work">Continue working</button></main></div>
      {layer}
    </div></div>
    {!narrow && <footer className="pc-statusbar" aria-label="Status bar" />}
  </div>;
}
