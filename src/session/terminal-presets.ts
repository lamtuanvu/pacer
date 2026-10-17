/** Safe terminal choices shared by browser/link and local callers. */
export const TERMINAL_PRESETS=['ghostty','iterm','terminal-app','wezterm','kitty','alacritty','gnome-terminal','x-terminal-emulator','auto'] as const;
export function isTerminalPreset(value:string):boolean{return (TERMINAL_PRESETS as readonly string[]).includes(value);}
export const TERMINAL_PRESET_ERROR='terminal.open requires a preset for app and link callers; use pacer config set terminal.open for custom templates';
