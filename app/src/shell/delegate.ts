import { createContext } from "preact";
import { useContext } from "preact/hooks";

/** Opens the Delegate dialog from a screen. Dispatch's New task uses it until the New task composer (Slice 11) replaces the dialog. */
export const DelegateContext = createContext<(() => void) | null>(null);
export const useDelegate = () => useContext(DelegateContext);
