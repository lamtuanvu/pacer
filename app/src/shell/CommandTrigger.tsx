import { Button, IconButton } from "../ds/Button";
import { DensityContext } from "../ds/Density";
import { Icon } from "../ds/icons";
import { Kbd } from "../ds/Kbd";
import { keyCaps } from "../keys/commands";

/** The title-bar search that opens the command menu: a wide field in the centre slot, or an icon button on narrow screens. */
export function CommandTrigger({ narrow = false, onOpen }: { narrow?: boolean; onOpen: (trigger: HTMLElement) => void }) {
  if (narrow) return <IconButton icon="search" aria-label="Search" aria-haspopup="dialog" data-command-trigger="" onClick={event => onOpen(event.currentTarget)} />;
  // One key cap: ⌘K on macOS, Ctrl K elsewhere.
  const caps = keyCaps("Mod-k");
  return <DensityContext.Provider value="compact"><Button variant="quiet" size="sm" className="pc-command-trigger" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" data-command-trigger="" onClick={event => onOpen(event.currentTarget)}>
    <span className="pc-command-trigger__icon" aria-hidden="true"><Icon name="topbar-search" /></span>
    <span className="pc-command-trigger__text">Search tasks, agents or run a command</span>
    <Kbd size="sm">{caps[0] === "⌘" ? caps.join("") : caps.join(" ")}</Kbd>
  </Button></DensityContext.Provider>;
}
